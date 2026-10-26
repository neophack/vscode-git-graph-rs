//! The compute gate: at most [`MAX_CONCURRENT_COMPUTES`] engine computes at once, with the
//! overflow waiting on Rust-side threads instead of libuv's.
//!
//! Every asynchronous binding call is a Node-API `AsyncTask`: its `compute` runs on libuv's
//! shared thread pool — four threads by default, shared with the file IO, crypto and DNS of
//! the whole extension host — so unconstrained engine traversals would monopolise that pool
//! and stall every other extension in the window. Node-API 3 (the version the oldest supported
//! editor's Node offers) has no threadsafe functions, so a private pool that reports back on
//! its own cannot be built from what napi-rs exposes either. What remains is to cap, and to
//! make the waiters wait somewhere else:
//!
//! - a request whose `compute` finds a free slot runs the engine work right there, exactly as
//!   the binding always has (the slot counter is the semaphore);
//! - a request that finds both slots taken enqueues its work and returns from `compute`
//!   immediately, freeing its libuv thread — queued jobs run on the gate's own worker threads,
//!   which never touch libuv at all;
//! - the queued request's promise is settled later by the delivery sentinel: one `AsyncTask`
//!   parked on the gate's condvar, woken by the first worker that finishes a job somebody is
//!   waiting for, settling every completed waiter on the JavaScript thread, and re-arming
//!   itself while any waiter remains. The gate holds at most one libuv thread this way, and
//!   only while overflow exists.
//!
//! The late promises need the two Node-API calls napi-rs does not expose under Node-API 3
//! (`Env::create_deferred` is Node-API 4 only because it settles from *background* threads
//! through a threadsafe function; ours never leave the JavaScript thread). Those calls are
//! this crate's only `unsafe`, isolated in [`LatePromise`] with their invariants spelled out.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use napi::bindgen_prelude::{Result, ToNapiValue, TypeName};
use napi::{check_status, Env, Task};

/// How many engine computes may run at once, across every protocol request and byte read the
/// binding serves. Two leaves half of the default pool for the rest of the host while keeping
/// the view's own loads (the opening load plus its follow-ups) running in parallel.
pub const MAX_CONCURRENT_COMPUTES: usize = 2;

/// How long the delivery sentinel parks between condvar wakes before re-checking on its own —
/// a lost-wakeup safety net, not a poll: workers signal the condvar the moment a waited-on job
/// finishes.
const SENTINEL_PARK: Duration = Duration::from_millis(250);

/// What one engine call answers, detached from the task that asked for it: the JSON envelope
/// of a protocol request, or the raw result of a file-bytes read.
pub enum EngineOutput {
    Envelope(String),
    Bytes(git_graph_core::Result<Option<Vec<u8>>>),
}

/// The outcome of submitting engine work to the gate, from a task's `compute` on a libuv thread.
pub enum Submission {
    /// A compute slot was free; the work ran inline and this is its answer.
    Computed(EngineOutput),
    /// Both slots were taken; the work is queued, and [`Gate::claim`] — on the JavaScript
    /// thread — turns this ticket into the answer or a late promise.
    Queued(u64),
}

/// The outcome of claiming a queued ticket, from a task's `resolve` on the JavaScript thread.
pub enum Claim {
    /// The worker finished before the caller came back; here is the answer.
    Ready(EngineOutput),
    /// Still queued or running; the promise settles with the answer when it lands.
    Late(LatePromise),
}

/// One queued job's bookkeeping. `job` is taken by the worker that runs it, `done` is set by
/// that worker, and `promise` is registered by the JavaScript side when it comes back for the
/// answer before that happens. A slot holding both a `promise` and a `done` answer is waiting
/// for the delivery sentinel; one holding only `done` waits for its own task's `resolve`.
struct Slot {
    job: Option<Box<dyn FnOnce() -> EngineOutput + Send>>,
    done: Option<EngineOutput>,
    promise: Option<LatePromise>,
}

impl Slot {
    fn queued(job: Box<dyn FnOnce() -> EngineOutput + Send>) -> Slot {
        Slot {
            job: Some(job),
            done: None,
            promise: None,
        }
    }
}

struct GateState {
    /// Jobs waiting for a worker, in arrival order.
    queue: VecDeque<u64>,
    slots: HashMap<u64, Slot>,
    /// Engine computes in flight — inline fast-path computes and worker computes together. This
    /// counter is the semaphore.
    in_flight: usize,
    /// Worker threads spawned so far (at most [`MAX_CONCURRENT_COMPUTES`], lazily).
    workers: usize,
    /// The most computes ever observed in flight at once — the cap's proof, for tests.
    peak_concurrency: usize,
}

/// The engine-wide compute gate. One instance serves both asynchronous entry points (`request`
/// and `requestBytes`), so the cap holds however the work arrives.
pub struct Gate {
    state: Mutex<GateState>,
    /// Workers wait here until a queued job sits behind a free compute slot.
    work_ready: Condvar,
    /// The delivery sentinel waits here until a finished job has somebody waiting for it.
    result_ready: Condvar,
    next_id: AtomicU64,
    /// Whether a delivery sentinel task exists right now. Touched only on the JavaScript thread
    /// (in a task's `resolve`), which makes the arm/disarm handshake sequential by construction.
    sentinel_armed: AtomicBool,
}

/// The one gate.
pub fn gate() -> &'static Gate {
    static GATE: OnceLock<Gate> = OnceLock::new();
    GATE.get_or_init(Gate::new)
}

impl Gate {
    fn new() -> Gate {
        Gate {
            state: Mutex::new(GateState {
                queue: VecDeque::new(),
                slots: HashMap::new(),
                in_flight: 0,
                workers: 0,
                peak_concurrency: 0,
            }),
            work_ready: Condvar::new(),
            result_ready: Condvar::new(),
            next_id: AtomicU64::new(1),
            sentinel_armed: AtomicBool::new(false),
        }
    }

    fn lock(&self) -> MutexGuard<'_, GateState> {
        // A poisoned lock means a panic inside the gate's bookkeeping; the state stays
        // structurally valid (every field is self-consistent or benignly stale), and the gate
        // is what keeps the host's thread pool usable — recovering beats wedging every later
        // engine request, the same trade the engine's own caches make.
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Submit engine work from a task's `compute` (a libuv thread). With a free slot the work
    /// runs inline and its answer comes back here; without one it is queued for a worker, and
    /// the caller returns a ticket its `resolve` claims on the JavaScript thread.
    pub(crate) fn submit<F>(&self, run: F) -> Submission
    where
        F: FnOnce() -> EngineOutput + Send + 'static,
    {
        {
            let mut state = self.lock();
            if state.in_flight < MAX_CONCURRENT_COMPUTES {
                state.in_flight += 1;
                state.peak_concurrency = state.peak_concurrency.max(state.in_flight);
            } else {
                let id = self.next_id.fetch_add(1, Ordering::Relaxed);
                state.slots.insert(id, Slot::queued(Box::new(run)));
                state.queue.push_back(id);
                self.ensure_workers(&mut state);
                // A parked worker may be waiting for a job rather than a slot (the queue was
                // empty when it parked); without this the belt-and-braces timeout is what
                // would eventually wake it.
                self.work_ready.notify_all();
                return Submission::Queued(id);
            }
        }
        // The slot is ours: run the engine work right here on the libuv thread, holding no lock,
        // exactly as the binding did before the gate existed.
        let output = run();
        let mut state = self.lock();
        state.in_flight -= 1;
        self.work_ready.notify_all();
        drop(state);
        Submission::Computed(output)
    }

    /// Claim a queued ticket from a task's `resolve` (the JavaScript thread). The worker may
    /// already have finished — then the answer is simply here — or the work may still sit in
    /// the queue, in which case a pending promise is registered and the sentinel settles it.
    pub(crate) fn claim(&self, env: &Env, id: u64) -> Result<Claim> {
        let promise = {
            let mut state = self.lock();
            match state.slots.get_mut(&id) {
                None => {
                    // Cannot happen: a ticket is claimed exactly once, and only delivery
                    // removes claimed slots. Answered defensively rather than panicking on the
                    // JavaScript thread.
                    return Err(napi::Error::new(
                        napi::Status::GenericFailure,
                        "the engine gate lost track of a queued request".to_owned(),
                    ));
                }
                Some(slot) => {
                    if let Some(output) = slot.done.take() {
                        state.slots.remove(&id);
                        return Ok(Claim::Ready(output));
                    }
                    let promise = LatePromise::create(env)?;
                    slot.promise = Some(promise);
                    promise
                }
            }
        };
        self.arm(env);
        Ok(Claim::Late(promise))
    }

    /// Park until at least one waited-on job has finished, and take everything deliverable with
    /// it — the delivery sentinel's `compute`, on a libuv thread. Returns empty when no waiter
    /// remains anywhere (the sentinel then disarms instead of re-arming).
    fn await_deliveries(&self) -> Vec<(LatePromise, EngineOutput)> {
        let mut state = self.lock();
        loop {
            let ready: Vec<u64> = state
                .slots
                .iter()
                .filter(|(_, slot)| slot.promise.is_some() && slot.done.is_some())
                .map(|(id, _)| *id)
                .collect();
            if !ready.is_empty() {
                let mut deliveries = Vec::with_capacity(ready.len());
                for id in ready {
                    if let Some(slot) = state.slots.remove(&id) {
                        if let (Some(promise), Some(output)) = (slot.promise, slot.done) {
                            deliveries.push((promise, output));
                        }
                    }
                }
                return deliveries;
            }
            if !state.slots.values().any(|slot| slot.promise.is_some()) {
                // Every waiter was served; slots without a promise are picked up by their own
                // task's `resolve`, queued or not.
                return Vec::new();
            }
            let (next, _timed_out) = self
                .result_ready
                .wait_timeout(state, SENTINEL_PARK)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state = next;
        }
    }

    /// Arm the delivery sentinel (from the JavaScript thread): spawn one unless one is already
    /// in flight. A spawn failure disarms so the next `claim` tries again — the next sentinel
    // delivers every completed waiter it finds, not only its own arming request's.
    fn arm(&self, env: &Env) {
        if self.sentinel_armed.swap(true, Ordering::SeqCst) {
            return;
        }
        if env.spawn(Delivery {}).is_err() {
            self.sentinel_armed.store(false, Ordering::SeqCst);
        }
    }

    /// The delivery sentinel's epilogue (on the JavaScript thread): re-arm while any waiter
    /// remains, otherwise stand down so the next `claim` can arm again.
    fn rearm(&self, env: &Env) {
        let waiters = self
            .lock()
            .slots
            .values()
            .any(|slot| slot.promise.is_some());
        let rearmed = waiters && env.spawn(Delivery {}).is_ok();
        if !rearmed {
            self.sentinel_armed.store(false, Ordering::SeqCst);
        }
    }

    /// A worker's completion: free the slot it held, record the answer (waking the sentinel if
    /// somebody waits for it) and wake whichever worker can now take the next queued job.
    fn complete(&self, id: u64, output: EngineOutput) {
        let mut state = self.lock();
        state.in_flight -= 1;
        if let Some(slot) = state.slots.get_mut(&id) {
            slot.done = Some(output);
            if slot.promise.is_some() {
                self.result_ready.notify_all();
            }
        }
        self.work_ready.notify_all();
    }

    /// Spawn the gate's worker threads up to the cap, lazily on first need. They park on
    /// [`Gate::work_ready`] when idle and live for the process's lifetime — they hold no
    /// JavaScript state, so a host that tears its environment down leaves them harmlessly
    /// parked.
    fn ensure_workers(&self, state: &mut GateState) {
        while state.workers < MAX_CONCURRENT_COMPUTES {
            state.workers += 1;
            let spawned = std::thread::Builder::new()
                .name("git-graph-engine".to_owned())
                .spawn(worker_loop);
            if spawned.is_err() {
                // Thread creation failed; the next submit retries. (Nothing else to do from a
                // libuv thread — and refusing to queue would lose the request outright.)
                state.workers -= 1;
                break;
            }
        }
    }

    /// The most computes ever observed in flight at once — how tests prove the cap holds.
    #[cfg(test)]
    pub(crate) fn peak_concurrency(&self) -> usize {
        self.lock().peak_concurrency
    }

    /// Park the calling thread until a queued job's answer is ready — the test-side form of the
    /// JavaScript side's late promise, and the proof that queued jobs really do complete.
    #[cfg(test)]
    pub(crate) fn wait_for(&self, id: u64) -> Option<EngineOutput> {
        let mut state = self.lock();
        loop {
            let slot = state.slots.get_mut(&id)?;
            if let Some(output) = slot.done.take() {
                state.slots.remove(&id);
                return Some(output);
            }
            let (next, _timed_out) = self
                .result_ready
                .wait_timeout(state, SENTINEL_PARK)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state = next;
        }
    }
}

/// One gate worker: take the oldest queued job a compute slot is free for, run it, complete it,
/// forever.
fn worker_loop() {
    let gate = gate();
    loop {
        let (id, run) = {
            let mut state = gate.lock();
            loop {
                if state.in_flight < MAX_CONCURRENT_COMPUTES {
                    if let Some(id) = state.queue.pop_front() {
                        if let Some(run) = state.slots.get_mut(&id).and_then(|slot| slot.job.take())
                        {
                            state.in_flight += 1;
                            state.peak_concurrency = state.peak_concurrency.max(state.in_flight);
                            break (id, run);
                        }
                        continue;
                    }
                }
                let (next, _timed_out) = gate
                    .work_ready
                    .wait_timeout(state, SENTINEL_PARK)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                state = next;
            }
        };
        let output = std::panic::catch_unwind(std::panic::AssertUnwindSafe(run)).unwrap_or_else(
			// The engine's entry points catch their own panics at the protocol boundary; this
			// guard is for whatever slips past them, so a bug costs one error answer instead
			// of the worker thread, its slot, and every promise behind it.
			|_| {
				EngineOutput::Envelope(
					r#"{"error":{"kind":"internal","message":"the engine compute panicked before the protocol boundary"}}"#
						.to_owned(),
				)
			},
		);
        gate.complete(id, output);
    }
}

/// The delivery sentinel: one `AsyncTask` at a time that parks on the gate until waited-on
/// work finishes, then settles the waiters' promises on the JavaScript thread. Its own promise
/// resolves to `undefined` and is never observed by anyone.
struct Delivery {}

impl Task for Delivery {
    type Output = Vec<(LatePromise, EngineOutput)>;
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(gate().await_deliveries())
    }

    fn resolve(&mut self, env: Env, deliveries: Self::Output) -> Result<()> {
        for (promise, output) in deliveries {
            settle(promise, &env, output)?;
        }
        gate().rearm(&env);
        Ok(())
    }
}

/// Settle one late promise with the engine answer it was waiting for.
fn settle(promise: LatePromise, env: &Env, output: EngineOutput) -> Result<()> {
    match output {
        EngineOutput::Envelope(answer) => promise.settle(env, answer),
        EngineOutput::Bytes(result) => promise.settle(env, crate::bytes_answer(result)),
    }
}

/// A pending JavaScript promise and its resolver, for settling an answer that is not ready on
/// the JavaScript thread yet.
///
/// Node-API 1 is all a `LatePromise` needs. The reason napi-rs gates its own deferred behind
/// Node-API 4 is settlement from *background* threads through a threadsafe function; these
/// never do that: a `LatePromise` is created on the JavaScript thread (in a task's `resolve`),
/// moved through the gate's queues, and settled on the JavaScript thread again (by the delivery
/// sentinel's `resolve`).
#[derive(Clone, Copy)]
pub struct LatePromise {
    deferred: napi::sys::napi_deferred,
    promise: napi::sys::napi_value,
}

// SAFETY: both handles are opaque, pointer-sized values with no thread affinity of their own.
// They are created, read and settled on the JavaScript thread only (see the type's docs);
// crossing threads inside the gate's queues moves them without ever dereferencing.
unsafe impl Send for LatePromise {}

impl LatePromise {
    fn create(env: &Env) -> Result<LatePromise> {
        let mut deferred = std::ptr::null_mut();
        let mut promise = std::ptr::null_mut();
        // SAFETY: called on the JavaScript thread with a valid env; both out-pointers are fresh
        // locals. `napi_create_promise` is Node-API 1.
        check_status!(
            unsafe { napi::sys::napi_create_promise(env.raw(), &mut deferred, &mut promise) },
            "could not create the promise of a queued engine request"
        )?;
        Ok(LatePromise { deferred, promise })
    }

    /// The pending promise, as the value a queued request's `resolve` hands back — the caller's
    /// own promise then settles with whatever settles this one.
    fn promise_value(&self) -> napi::sys::napi_value {
        self.promise
    }

    /// Resolve the promise with `value`; called once, on the JavaScript thread that created it.
    fn settle<T: ToNapiValue>(self, env: &Env, value: T) -> Result<()> {
        // SAFETY: converting a value on the JavaScript thread with the env that owns it — the
        // same conversion every task's `resolve` return goes through.
        let value = unsafe { ToNapiValue::to_napi_value(env.raw(), value) }?;
        // SAFETY: the deferred was created on this thread's env and is settled here, exactly
        // once (the gate removes a delivered slot before the sentinel sees it again).
        // `napi_resolve_deferred` is Node-API 1.
        check_status!(
            unsafe { napi::sys::napi_resolve_deferred(env.raw(), self.deferred, value) },
            "could not settle the promise of a queued engine request"
        )
    }
}

/// What a gated task's `resolve` hands JavaScript: the answer itself when the compute ran
/// inline, or the pending promise the delivery sentinel settles when the work was queued. A
/// promise resolved with a promise settles through the inner one, so both arms behave as the
/// single `Promise<T>` the call's TypeScript signature promises.
pub enum GatedAnswer<T> {
    Now(T),
    Later(LatePromise),
}

impl<T: ToNapiValue> ToNapiValue for GatedAnswer<T> {
    unsafe fn to_napi_value(env: napi::sys::napi_env, val: Self) -> Result<napi::sys::napi_value> {
        match val {
            GatedAnswer::Now(value) => ToNapiValue::to_napi_value(env, value),
            GatedAnswer::Later(promise) => Ok(promise.promise_value()),
        }
    }
}

impl<T> TypeName for GatedAnswer<T> {
    fn type_name() -> &'static str {
        "Promise"
    }

    fn value_type() -> napi::ValueType {
        napi::ValueType::Object
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::{Arc, Mutex};

    /// The tests share the process-wide gate, so they run one at a time; this lock is theirs,
    /// not the gate's.
    static TESTS: Mutex<()> = Mutex::new(());

    /// A job that sleeps `for_ms` while tracking how many jobs run at once, answering with its
    /// tag — enough work for the cap to be observable.
    fn tracked_sleep_job(
        concurrent: &Arc<AtomicUsize>,
        peak: &Arc<AtomicUsize>,
        tag: &'static str,
        for_ms: u64,
    ) -> Box<dyn FnOnce() -> EngineOutput + Send> {
        let concurrent = Arc::clone(concurrent);
        let peak = Arc::clone(peak);
        Box::new(move || {
            let now = concurrent.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(now, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(for_ms));
            concurrent.fetch_sub(1, Ordering::SeqCst);
            EngineOutput::Envelope(tag.to_owned())
        })
    }

    fn envelope_of(output: Option<EngineOutput>) -> String {
        match output {
            Some(EngineOutput::Envelope(answer)) => answer,
            _ => String::new(),
        }
    }

    /// Wait out every submission of a batch, so the assertions see the run that happened, not
    /// the run still in flight.
    fn drain(submissions: Vec<Submission>) {
        for submission in submissions {
            if let Submission::Queued(id) = submission {
                gate().wait_for(id).expect("queued job completed");
            }
        }
    }

    #[test]
    fn at_most_two_computes_run_at_once() {
        let _serial = TESTS.lock().unwrap();
        // Eight concurrent long jobs go through the real submission path — the inline fast path
        // and the worker queue together — and never once overlap more than two deep.
        let concurrent = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let submitters: Vec<_> = (0..8)
            .map(|_| {
                let concurrent = Arc::clone(&concurrent);
                let peak = Arc::clone(&peak);
                std::thread::spawn(move || {
                    gate().submit(tracked_sleep_job(&concurrent, &peak, "job", 40))
                })
            })
            .collect();
        let submissions: Vec<Submission> = submitters
            .into_iter()
            .map(|handle| handle.join().expect("submitter finished"))
            .collect();
        let queued = submissions
            .iter()
            .filter(|submission| matches!(submission, Submission::Queued(_)))
            .count();
        drain(submissions);
        assert!(
            queued > 0,
            "with eight jobs over two slots, some must queue"
        );

        // peak was observed inside the jobs themselves; the gate keeps its own copy of the same
        // observation, which is what a host could report.
        assert!(
            peak.load(Ordering::SeqCst) <= MAX_CONCURRENT_COMPUTES,
            "{} computes overlapped",
            peak.load(Ordering::SeqCst)
        );
        assert_eq!(
            peak.load(Ordering::SeqCst),
            MAX_CONCURRENT_COMPUTES,
            "the cap allows — and the workers use — two computes in parallel"
        );
        assert_eq!(gate().peak_concurrency(), MAX_CONCURRENT_COMPUTES);
    }

    #[test]
    fn queued_jobs_complete_and_answer_after_the_slots_free() {
        let _serial = TESTS.lock().unwrap();
        // Both slots busy on other threads, then one short job from this thread: it must queue
        // (the slots are taken), be picked up by a worker once one frees, and answer intact.
        let concurrent = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let holders: Vec<_> = (0..MAX_CONCURRENT_COMPUTES)
            .map(|i| {
                let concurrent = Arc::clone(&concurrent);
                let peak = Arc::clone(&peak);
                std::thread::spawn(move || {
                    let tag: &'static str = if i == 0 { "hold-one" } else { "hold-two" };
                    gate().submit(tracked_sleep_job(&concurrent, &peak, tag, 120))
                })
            })
            .collect();
        // Give the holders time to take both slots; then the short job cannot run inline.
        std::thread::sleep(Duration::from_millis(20));
        let overflow = gate().submit(tracked_sleep_job(&concurrent, &peak, "overflow", 1));
        let Submission::Queued(id) = overflow else {
            panic!("with both slots taken the job must queue, not run inline");
        };
        let answer = envelope_of(gate().wait_for(id));
        assert_eq!(answer, "overflow");
        let submissions: Vec<Submission> = holders
            .into_iter()
            .map(|handle| handle.join().expect("holder finished"))
            .collect();
        drain(submissions);
        assert_eq!(gate().peak_concurrency(), MAX_CONCURRENT_COMPUTES);
    }
}
