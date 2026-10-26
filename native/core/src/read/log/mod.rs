//! Walking the commit graph.
//!
//! ## Ordering
//!
//! All three orderings git offers are *topologically constrained*: a commit is never shown before
//! one of its children, and within that constraint the ready commits are ranked by commit date,
//! author date, or by staying on the current line of history.
//!
//! gix's traversal offers a commit-time priority queue but no topological guarantee, so the
//! ordering is done here instead: the traversal collects a **window** of commits, and the window is
//! then re-ordered by a Kahn-style topological sort whose ready set is ranked according to the
//! requested ordering. The window is a multiple of the requested page rather than the whole
//! history, which is what makes the first screen of a million-commit repository affordable —
//! ordering is exact within the window, and commits beyond it are not considered.
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
