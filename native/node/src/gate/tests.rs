//! Unit tests for the compute gate (see `mod.rs`).

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
        tag.to_owned()
    })
}

fn envelope_of(output: Option<EngineOutput>) -> String {
    output.unwrap_or_default()
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
