//! Walking the commit graph.
//!
//! ## Ordering
//!
//! All three orderings git offers are *topologically constrained*: a commit is never shown before
//! one of its children, and within that constraint the ready commits are ranked by commit date,
//! author date, or by staying on the current line of history.
//!
//! gix's traversal offers a commit-time priority queue but no topological guarantee, so the
//! ordering is done here instead. The date-ordered window is collected directly in git's shape
//! ([`walk`]): one pass counting every reachable commit's children (git's `limit_list`), then a
//! ready set ranked by the requested ordering ([`ordering`]'s Kahn sort), cut at the window. The
//! count pass is what keeps the ordering correct where a naive commit-time queue goes wrong: a
//! commit whose date is older than the history around it — an out-of-band commit under a pinned
//! date, an imported branch — is held by its own newest line until the tips sitting on the line
//! have been shown, exactly as `git log --date-order` shows it. The window is a multiple of the
//! requested page rather than the whole history; the ordering is exact over the page it returns,
//! and commits beyond it are not considered. Filtered walks (`--author`, path filters) keep the
//! traversal-shaped search they need ([`filter`]).
//!
//! ## Layout
//!
//! The submodules follow that pipeline: [`walk`] runs the traversal that reads the commits,
//! [`filter`] holds the author and path filters plus the re-parenting that keeps a filtered
//! history connected, [`window`] sizes the window and splices pinned commits into the page,
//! [`ordering`] re-orders a window by git's orderings, [`tips`] resolves the revisions a walk
//! starts from, and [`search`] answers the history scans that do not build the graph (message
//! search, commit counting, author listing). The public surface is re-exported here, so callers
//! keep addressing it as `crate::read::log`.

mod filter;
mod ordering;
mod search;
mod tips;
mod walk;
mod window;

use crate::model::CommitRecord;

pub use ordering::order_records;
pub use search::{authors, count_commits_before, search_history};
pub(crate) use tips::stash_tip;
pub use tips::{all_tips, resolve_tips};
pub use walk::{read_commit, walk_windowed, WalkOptions};
pub use window::pin_commits;
pub(crate) use window::window_size;

/// A completed walk: every commit it read, in walk order, after any filter re-parenting. This is
/// the unit the incremental cache ([`crate::read::incremental`]) stores and continues from — a
/// later load that only adds commits re-orders this list together with the new part, instead of
/// reading it again — and the unit `read::graph` orders and cuts the page from.
#[derive(Debug, Clone, Default)]
pub struct WalkResult {
    pub window: Vec<CommitRecord>,
}
