//! Unit tests for the incremental traversal store (see `mod.rs`).

use super::*;

fn log_options(ordering: CommitOrdering) -> LogOptions {
    LogOptions {
        max_commits: 50,
        show_tags: true,
        show_remote_branches: true,
        commit_ordering: ordering,
        ..Default::default()
    }
}

#[test]
fn the_key_covers_every_walk_affecting_option() {
    let base = log_options(CommitOrdering::Date);
    let key = CacheKey::of(&base);
    assert_eq!(key, CacheKey::of(&log_options(CommitOrdering::Date)));
    assert_ne!(key, CacheKey::of(&log_options(CommitOrdering::Topo)));

    let mut other = base.clone();
    other.max_commits += 1;
    assert_ne!(key, CacheKey::of(&other));

    // The fields that only shape the answer around the walk do not partake: a load that
    // differs only in them shares the traversal, so it shares the cache.
    let mut annotated = base.clone();
    annotated.remotes.push("origin".into());
    annotated.defer_uncommitted_changes = true;
    annotated.show_untracked_files = false;
    annotated.show_uncommitted_changes = false;
    assert_eq!(key, CacheKey::of(&annotated));

    // The ref-scan fields do partake: they change which commits the walk starts from.
    let mut hidden = base;
    hidden.hide_remotes.push("secret".into());
    assert_ne!(key, CacheKey::of(&hidden));
}

#[test]
fn only_plain_walks_are_eligible() {
    assert!(eligible(&log_options(CommitOrdering::Topo)));

    let mut filtered = log_options(CommitOrdering::Topo);
    filtered.authors = Some(vec!["Test User".into()]);
    assert!(!eligible(&filtered));

    let mut by_path = log_options(CommitOrdering::Topo);
    by_path.filter_paths = vec!["src".into()];
    assert!(!eligible(&by_path));

    let mut pinned = log_options(CommitOrdering::Topo);
    pinned.gerrit_refs = Some(vec!["refs/changes/01/1".into()]);
    assert!(!eligible(&pinned));

    let mut first_parent = log_options(CommitOrdering::Topo);
    first_parent.only_follow_first_parent = true;
    assert!(!eligible(&first_parent));

    let mut reflogs = log_options(CommitOrdering::Topo);
    reflogs.include_commits_mentioned_by_reflogs = true;
    assert!(!eligible(&reflogs));
}

#[test]
fn the_store_keeps_the_latest_traversal_per_key_and_invalidates_by_root() {
    let store = Store::default();
    let root = Path::new("/repo");
    let key = CacheKey::of(&log_options(CommitOrdering::Date));
    let tips = [ObjectId::from_hex(b"0000000000000000000000000000000000000001").unwrap()];
    let record = |date: i64| CommitRecord {
        hash: format!("{date:040}"),
        parents: Vec::new(),
        author: String::new(),
        email: String::new(),
        date,
        author_date: date,
        message: String::new(),
    };
    store.put(root, &key, CachedWalk::new(&tips, vec![record(1)]));
    store.put(
        root,
        &key,
        CachedWalk::new(&tips, vec![record(2), record(1)]),
    );
    assert_eq!(store.get(root, &key).unwrap().window.len(), 2);
    assert!(store
        .get(root, &CacheKey::of(&log_options(CommitOrdering::Topo)))
        .is_none());

    store.invalidate(root);
    assert!(store.get(root, &key).is_none());
}

#[test]
fn a_cached_walk_holds_ids_not_hex_and_knows_its_own_size() {
    let tips = [
        ObjectId::from_hex(b"0000000000000000000000000000000000000001").unwrap(),
        ObjectId::from_hex(b"0000000000000000000000000000000000000002").unwrap(),
    ];
    let window = vec![CommitRecord {
        hash: "0000000000000000000000000000000000000003".into(),
        parents: vec!["0000000000000000000000000000000000000004".into()],
        author: "Author Name".into(),
        email: "author@example.com".into(),
        date: 2,
        author_date: 1,
        message: "the subject".into(),
    }];
    let walk = CachedWalk::new(&tips, window);
    assert!(walk
        .visited
        .contains(&ObjectId::from_hex(b"0000000000000000000000000000000000000003").unwrap()));
    assert!(walk.tips.contains(&tips[0]) && walk.tips.contains(&tips[1]));

    // The size the budget evicts by: the record's four strings, one parent string, and the
    // three ids of the visited/tip sets (each id plus a bucket), with a header allowance.
    let three_ids = 3 * (std::mem::size_of::<ObjectId>() + std::mem::size_of::<usize>());
    let expected = std::mem::size_of::<CommitRecord>()
        + 4 * std::mem::size_of::<String>()
        + 40
        + "Author Name".len()
        + "author@example.com".len()
        + "the subject".len()
        + std::mem::size_of::<String>()
        + 40
        + three_ids
        + std::mem::size_of::<Vec<CommitRecord>>();
    assert_eq!(walk.size_bytes, expected);
}

#[test]
fn the_budget_evicts_least_recently_used_first() {
    // A store whose whole budget is two records: inserting a third must drop the least
    // recently used one, never the entry just inserted.
    let record = |date: i64| CommitRecord {
        hash: format!("{date:040}"),
        parents: Vec::new(),
        author: String::new(),
        email: String::new(),
        date,
        author_date: date,
        message: String::new(),
    };
    let one_entry = |store: &Store| {
        store
            .lock()
            .slots
            .values()
            .map(|s| s.walk.size_bytes)
            .sum::<usize>()
    };
    let tips = [ObjectId::from_hex(b"0000000000000000000000000000000000000001").unwrap()];
    let store = Store::with_budget(usize::MAX);
    let probe = CachedWalk::new(&tips, vec![record(1)]);
    store.put(
        Path::new("/r"),
        &CacheKey::of(&log_options(CommitOrdering::Date)),
        probe,
    );
    let budget = one_entry(&store) * 2 + std::mem::size_of::<Vec<CommitRecord>>() * 2;
    let store = Store::with_budget(budget);

    let root = Path::new("/repo");
    let date_key = CacheKey::of(&log_options(CommitOrdering::Date));
    let topo_key = CacheKey::of(&log_options(CommitOrdering::Topo));
    let mut hidden_key = log_options(CommitOrdering::Date);
    hidden_key.show_tags = false;
    let hidden_key = CacheKey::of(&hidden_key);
    store.put(root, &date_key, CachedWalk::new(&tips, vec![record(1)]));
    store.put(root, &topo_key, CachedWalk::new(&tips, vec![record(2)]));
    assert_eq!(store.lock().slots.len(), 2);

    // Touch the date entry so the topo one becomes the least recently used, then overflow:
    // the topo entry goes, the date entry survives.
    let _ = store.get(root, &date_key);
    store.put(root, &hidden_key, CachedWalk::new(&tips, vec![record(3)]));
    assert!(
        store.get(root, &date_key).is_some(),
        "the touched entry outlives the overflow"
    );
    assert!(
        store.get(root, &topo_key).is_none(),
        "the stale entry was evicted"
    );
    assert!(
        store.get(root, &hidden_key).is_some(),
        "the newest entry stays"
    );
}

#[test]
fn a_single_entry_larger_than_the_budget_is_kept_rather_than_dropped() {
    let tips = [ObjectId::from_hex(b"0000000000000000000000000000000000000001").unwrap()];
    let record = |date: i64| CommitRecord {
        hash: format!("{date:040}"),
        parents: Vec::new(),
        author: String::new(),
        email: String::new(),
        date,
        author_date: date,
        message: String::new(),
    };
    let store = Store::with_budget(1);
    let root = Path::new("/repo");
    let key = CacheKey::of(&log_options(CommitOrdering::Date));
    store.put(root, &key, CachedWalk::new(&tips, vec![record(1)]));
    assert!(store.get(root, &key).is_some());
}

#[test]
fn bytes_for_counts_only_the_named_repository() {
    let tips = [ObjectId::from_hex(b"0000000000000000000000000000000000000001").unwrap()];
    let record = |date: i64| CommitRecord {
        hash: format!("{date:040}"),
        parents: Vec::new(),
        author: String::new(),
        email: String::new(),
        date,
        author_date: date,
        message: String::new(),
    };
    let store = Store::default();
    let left = Path::new("/left");
    let right = Path::new("/right");
    let key = CacheKey::of(&log_options(CommitOrdering::Date));
    store.put(left, &key, CachedWalk::new(&tips, vec![record(1)]));
    store.put(
        right,
        &key,
        CachedWalk::new(&tips, vec![record(2), record(3)]),
    );

    let left_bytes = store.bytes_for(left);
    let right_bytes = store.bytes_for(right);
    assert!(left_bytes > 0 && right_bytes > left_bytes);
    assert_eq!(store.bytes_for(Path::new("/elsewhere")), 0);
}
