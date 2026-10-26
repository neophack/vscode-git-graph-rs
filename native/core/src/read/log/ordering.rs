//! The topologically constrained orderings of a window of commits.

use std::collections::{BinaryHeap, HashMap};

use crate::model::{CommitOrdering, CommitRecord};

/// Ranking key for the ready set, matching what each of git's orderings prioritises.
#[derive(PartialEq, Eq)]
struct Ready {
    /// The date the ordering ranks by; unused (and zero) for topological order.
    date: i64,
    /// Position in the traversal, used to break ties and to drive topological order.
    sequence: usize,
    index: usize,
    ordering: CommitOrdering,
}

impl Ord for Ready {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        match self.ordering {
            // Newest first, ties broken by the order the traversal found them.
            CommitOrdering::Date | CommitOrdering::AuthorDate => self
                .date
                .cmp(&other.date)
                .then_with(|| other.sequence.cmp(&self.sequence)),
            // Topological order keeps walking down the line of history it is already on, rather
            // than intermixing branches: the most recently readied commit wins.
            CommitOrdering::Topo => self.sequence.cmp(&other.sequence),
        }
    }
}

impl PartialOrd for Ready {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// Topologically sort `records`, ranking the commits that are ready to be shown by `ordering`.
///
/// Public because the incremental traversal ([`crate::read::incremental`]) re-orders a merged window —
/// the new records plus a cached one — through exactly this function, which is what makes its
/// page the page a full walk would have produced.
pub fn order_records(
    records: &[CommitRecord],
    ordering: CommitOrdering,
    limit: usize,
) -> Vec<CommitRecord> {
    let index_of: HashMap<&str, usize> = records
        .iter()
        .enumerate()
        .map(|(index, record)| (record.hash.as_str(), index))
        .collect();

    // How many children inside the window each commit is still waiting for.
    let mut pending = vec![0usize; records.len()];
    for record in records {
        for parent in &record.parents {
            if let Some(&parent_index) = index_of.get(parent.as_str()) {
                pending[parent_index] += 1;
            }
        }
    }

    let key = |record: &CommitRecord| match ordering {
        CommitOrdering::Date => record.date,
        CommitOrdering::AuthorDate => record.author_date,
        CommitOrdering::Topo => 0,
    };

    let mut initial: Vec<usize> = (0..records.len())
        .filter(|&index| pending[index] == 0)
        .collect();
    // Topological order pops the highest sequence first, so seeding the ready set in walk order
    // would start from the *oldest* tip. git reverses its initial queue (`prio_queue_reverse` in
    // `sort_in_topological_order`) so the newest tip comes out first; seeding in reverse does the
    // same. The date orderings rank by date and only use the sequence to break ties, lowest first.
    if ordering == CommitOrdering::Topo {
        initial.reverse();
    }

    let mut sequence = 0usize;
    let mut ready: BinaryHeap<Ready> = BinaryHeap::new();
    for index in initial {
        ready.push(Ready {
            date: key(&records[index]),
            sequence,
            index,
            ordering,
        });
        sequence += 1;
    }

    let mut ordered: Vec<CommitRecord> = Vec::with_capacity(limit.min(records.len()));
    let mut taken = vec![false; records.len()];
    while let Some(next) = ready.pop() {
        if ordered.len() == limit {
            break;
        }
        taken[next.index] = true;
        for parent in &records[next.index].parents {
            let Some(&parent_index) = index_of.get(parent.as_str()) else {
                continue;
            };
            pending[parent_index] -= 1;
            if pending[parent_index] == 0 {
                ready.push(Ready {
                    date: key(&records[parent_index]),
                    sequence,
                    index: parent_index,
                    ordering,
                });
                sequence += 1;
            }
        }
        ordered.push(records[next.index].clone());
    }

    ordered
}
