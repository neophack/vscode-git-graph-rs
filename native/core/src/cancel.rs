//! Cooperative cancellation of long-running requests.
//!
//! A host that issues a full-graph traversal cannot leave the user waiting for it: when the view
//! switches repository, or a newer request of the same kind supersedes an older one (the host
//! scheduler), the older request's work is unwanted while it is still running. The
//! engine therefore lets the host name each request — a `requestId` it picks — and cancel it by
//! that name at any time.
//!
//! The two halves:
//!
//! - A [`Cancel`] token is what a request *observes*. Most requests have none ([`Cancel::none`]):
//!   the checks in the traversal loops then cost one null check and nothing more. A token that a
//!   host did name carries an [`AtomicBool`] shared with the registry.
//! - The [`Registry`] maps request ids to those flags, process-wide, exactly as [`crate::repository::RepoManager`]
//!   maps paths to repository handles. The Node binding registers the id when the request starts
//!   (see [`protocol::request_with_id`]) and `cancel(requestId)` sets the flag from any thread.
//!
//! Cancellation is *cooperative*: the long-running loops — the graph walk, the history search, the
//! statistics walks, the working-tree scan — check the flag every [`CHECK_INTERVAL`] iterations
//! and unwind with [`ErrorKind::Cancelled`](crate::ErrorKind::Cancelled). A relaxed atomic load
//! every 256th iteration is unmeasurable next to the commit decode each of those iterations pays,
//! and nothing is invalidated by it: handles stay warm, caches stay populated, and re-issuing the
//! request answers exactly what it answered before (see `tests/cancellation.rs`).
//!
//! Ordering a cancellation ahead of its request is supported: `cancel(id)` on an id no request
//! registered yet is remembered, so the request that later runs under that id answers `Cancelled`
//! at its first checkpoint rather than doing unwanted work. A request that finishes clears its
//! entry — the id can then be reused, and answers normally.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use crate::error::{Error, Result};

/// How many loop iterations run between two cancellation checks.
///
/// 256 balances promptness against overhead: a check is one relaxed atomic load, and at this
/// interval the walk notices a cancellation after at most 256 commit decodes — around a
/// millisecond on the repositories this engine serves — while the per-iteration amortised cost
/// stays far below the traversal-time budget the plan sets (≤ 2%).
pub const CHECK_INTERVAL: usize = 256;

/// How many cancellations that raced AHEAD of their request are remembered.
///
/// A well-behaved host's cancel leads its request by microseconds, so a short FIFO of the most
/// recent ones is far more than the contract ever needs — while a caller that mints a fresh id
/// per cancel (or cancels ids that never run) cannot grow the registry without bound: its own
/// older pre-cancellations are the first entries evicted.
const PRE_CANCELLED_LIMIT: usize = 64;

/// The cancellation state of one request, as the traversal loops see it.
///
/// Cheap to clone (one `Option<Arc>`); cheap to construct ([`Cancel::none`]); never panics.
#[derive(Clone, Debug, Default)]
pub struct Cancel {
    flag: Option<Arc<AtomicBool>>,
}

impl Cancel {
    /// A request that cannot be cancelled: every check compiles to a null test.
    pub fn none() -> Self {
        Cancel { flag: None }
    }

    /// Has the caller cancelled the request this token belongs to?
    ///
    /// A relaxed load is enough: there is no interleaving to guard — the loops only ever read the
    /// flag, and a check that observes the cancellation one instruction late still observes it.
    pub fn is_cancelled(&self) -> bool {
        self.flag
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Relaxed))
    }

    /// The checkpoint a long-running loop passes every [`CHECK_INTERVAL`] iterations.
    ///
    /// `iteration` is the loop's own counter (1-based); the check itself is the flag read above.
    pub fn check(&self, iteration: usize) -> Result<()> {
        if iteration.is_multiple_of(CHECK_INTERVAL) && self.is_cancelled() {
            return Err(Error::cancelled());
        }
        Ok(())
    }
}

/// The registry of cancellable requests: request id → cancellation flag, process-wide.
///
/// The ids are the host's own (`requestId`); the engine only requires that one id name at most one
/// in-flight request, since the registry holds one entry per id.
#[derive(Debug, Default)]
pub struct Registry {
    entries: Mutex<HashMap<u32, Arc<AtomicBool>>>,
    /// The ids cancelled before any request registered them, oldest first (bounded to
    /// [`PRE_CANCELLED_LIMIT`]; in-flight entries are removed by their guards, so only this
    /// half of the registry needs a bound).
    pre_cancelled: Mutex<VecDeque<u32>>,
}

impl Registry {
    /// The process-wide registry, alongside [`crate::RepoManager::global`]: the Node binding and
    /// the protocol both reach it from wherever a request starts or is cancelled.
    pub fn global() -> &'static Registry {
        static GLOBAL: OnceLock<Registry> = OnceLock::new();
        GLOBAL.get_or_init(Registry::default)
    }

    /// Flag the request `id` as cancelled.
    ///
    /// When the request is in flight its flag is set and the next checkpoint in its loop unwinds
    /// with `Cancelled`. When no request has registered the id yet — the cancellation raced ahead
    /// of the request — the id is remembered, and the request that later runs under this id
    /// observes the cancellation at once (see [`Registry::register`]); only the most recent
    /// [`PRE_CANCELLED_LIMIT`] such ids are remembered. Cancelling an id that is neither in flight
    /// nor about to start is a no-op apart from that remembered id.
    pub fn cancel(&self, id: u32) {
        {
            let entries = self.lock();
            if let Some(flag) = entries.get(&id) {
                flag.store(true, Ordering::Relaxed);
                return;
            }
        }
        let mut pending = self.lock_pre_cancelled();
        if !pending.contains(&id) {
            pending.push_back(id);
            while pending.len() > PRE_CANCELLED_LIMIT {
                pending.pop_front();
            }
        }
    }

    /// Register `id` for the duration of one request, returning the guard that owns the
    /// registration together with the request's token.
    ///
    /// A cancellation that arrived before this call becomes the token's starting state, so the
    /// request answers `Cancelled` at its first checkpoint instead of running unwanted work.
    /// Registering an id that is already in flight replaces its entry: one id must name one
    /// in-flight request, and the caller that reuses it mid-flight simply detaches the older
    /// request's cancellation.
    pub fn register(&self, id: u32) -> Guard {
        let mut pre_cancelled = {
            let mut pending = self.lock_pre_cancelled();
            let known = pending.contains(&id);
            if known {
                pending.retain(|other| *other != id);
            }
            known
        };
        let flag = {
            let mut entries = self.lock();
            if entries
                .remove(&id)
                .is_some_and(|flag| flag.load(Ordering::Relaxed))
            {
                pre_cancelled = true;
            }
            let flag = Arc::new(AtomicBool::new(pre_cancelled));
            entries.insert(id, Arc::clone(&flag));
            flag
        };
        Guard {
            id,
            token: Cancel { flag: Some(flag) },
        }
    }

    /// Drop the registration of a finished request. Guard's `Drop` calls this; it exists for
    /// symmetry and for callers that hold the id rather than the guard.
    pub fn unregister(&self, id: u32) {
        self.lock().remove(&id);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u32, Arc<AtomicBool>>> {
        // A poisoned lock means a panic while holding it; the registry is a cache of flags, not a
        // consistency-critical structure, so recovering beats failing every later request.
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_pre_cancelled(&self) -> std::sync::MutexGuard<'_, VecDeque<u32>> {
        self.pre_cancelled
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// The registration of one in-flight request: dropping it removes the id from the [`Registry`],
/// which is what makes an id reusable by a later request.
#[derive(Debug)]
pub struct Guard {
    id: u32,
    token: Cancel,
}

impl Guard {
    /// The request's cancellation token: clone it into the calls that loop.
    pub fn token(&self) -> Cancel {
        self.token.clone()
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        Registry::global().unregister(self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_without_a_flag_is_never_cancelled() {
        assert!(!Cancel::none().is_cancelled());
        assert!(Cancel::none().check(CHECK_INTERVAL).is_ok());
    }

    #[test]
    fn cancelling_an_in_flight_request_unwinds_at_the_next_checkpoint() {
        let guard = Registry::global().register(1);
        assert!(!guard.token().is_cancelled());
        Registry::global().cancel(1);
        assert!(guard.token().is_cancelled());
        assert_eq!(
            guard.token().check(CHECK_INTERVAL).unwrap_err().kind,
            crate::ErrorKind::Cancelled
        );
        // Only every CHECK_INTERVAL-th iteration reads the flag.
        assert!(guard.token().check(CHECK_INTERVAL + 1).is_ok());
    }

    #[test]
    fn a_cancellation_ahead_of_its_request_is_remembered() {
        Registry::global().cancel(2);
        let guard = Registry::global().register(2);
        assert!(guard.token().is_cancelled());
    }

    #[test]
    fn a_finished_request_leaves_its_id_reusable() {
        {
            let guard = Registry::global().register(3);
            Registry::global().cancel(3);
            assert!(guard.token().is_cancelled());
        }
        let guard = Registry::global().register(3);
        assert!(
            !guard.token().is_cancelled(),
            "the id's second request starts clean"
        );
    }

    #[test]
    fn cancelling_an_unknown_id_harms_no_other_request() {
        Registry::global().cancel(u32::MAX);
        let guard = Registry::global().register(4);
        assert!(!guard.token().is_cancelled());
    }

    #[test]
    fn pre_cancelled_ids_are_bounded_and_the_oldest_is_evicted_first() {
        // A caller that cancels ids no request ever runs must not grow the registry: beyond the
        // limit, its own OLDEST remembered cancellations are the ones dropped.
        let base: u32 = 1_000_000;
        for id in base..(base + PRE_CANCELLED_LIMIT as u32 + 10) {
            Registry::global().cancel(id);
        }
        let evicted = Registry::global().register(base);
        assert!(
            !evicted.token().is_cancelled(),
            "the oldest pre-cancellation was evicted by the flood"
        );
        let remembered = Registry::global().register(base + PRE_CANCELLED_LIMIT as u32 + 9);
        assert!(
            remembered.token().is_cancelled(),
            "the most recent pre-cancellation is still remembered"
        );
    }
}
