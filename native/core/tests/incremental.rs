//! The incremental traversal and the refs re-annotation (refactor plan, task 2.10).
//!
//! The property at the heart of the incremental cache: after **any** operation a user or a fetch
//! can perform, the page the engine answers from the cache must be *identical* — commit order,
//! parents, ref annotations, `moreCommitsAvailable`, everything — to the page a full traversal
//! of the same repository produces, under both date and topo ordering. Random operation
//! sequences (seeded, reproducible from the seed in every assertion message) drive that
//! property; deterministic scenarios pin the interesting individual behaviours: that a plain
//! refresh really is answered from the cache, that history rewrites really do fall back, that
//! `annotate` re-labels exactly what a full load would, and that a commit-graph file changes
//! nothing.

#[macro_use]
mod common;

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::process::Command;

use common::TestRepo;
use git_graph_core::cancel::Cancel;
use git_graph_core::model::{
    AnnotateParams, CommitOrdering, LogOptions, RefOptions, RefReadOptions,
};
use git_graph_core::protocol;
use git_graph_core::read::graph;
use git_graph_core::read::incremental;
use git_graph_core::repository::Repo;
use serde::Serialize;

/* ---------- A seeded generator, so every case is reproducible ---------- */

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Rng {
        Rng(seed.wrapping_mul(0x9E3779B97F4A7C15) | 1)
    }

    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }

    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound.max(1)
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len() as u64) as usize]
    }
}

/* ---------- The operation driver ---------- */

/// One fixture repository plus everything the driver knows about it: where each branch points,
/// every commit's parents (plumbing commits are created here, so the graph is bookkept here),
/// and a clock that advances 60 s per commit — distinct, increasing timestamps keep date
/// ordering deterministic however fast the machine runs.
struct Driver {
    repo: TestRepo,
    rng: Rng,
    /// Branch name → head hash.
    heads: BTreeMap<String, String>,
    /// Commit hash → its parents, as created.
    parents: HashMap<String, Vec<String>>,
    /// The branch HEAD points at.
    current: String,
    /// The tree every plumbing commit re-uses (the graph tests care about reachability, not
    /// trees).
    tree: String,
    clock: i64,
    counter: usize,
}

impl Driver {
    fn new(repo: TestRepo, seed: u64) -> Driver {
        let tree = repo.git(&["rev-parse", "HEAD^{tree}"]).trim().to_string();
        let clock = repo
            .git(&["log", "-1", "--format=%ct"])
            .trim()
            .parse()
            .unwrap();
        let head = repo.head();
        let mut parents = HashMap::new();
        parents.insert(head.clone(), Vec::new());
        let mut heads = BTreeMap::new();
        heads.insert("main".to_string(), head);
        Driver {
            repo,
            rng: Rng::new(seed),
            heads,
            parents,
            current: "main".to_string(),
            tree,
            clock,
            counter: 0,
        }
    }

    fn next_name(&mut self) -> usize {
        self.counter += 1;
        self.counter
    }

    /// Create a commit with the given parents, at the next tick of the clock, through plumbing:
    /// no working tree is touched, so every load stays clean and no uncommitted row appears.
    fn commit_tree(&mut self, parents: &[String], message: &str) -> String {
        self.clock += 60;
        let date = format!("{} +0000", self.clock);
        let mut args: Vec<String> = vec!["commit-tree".into(), self.tree.clone()];
        for parent in parents {
            args.push("-p".into());
            args.push(parent.clone());
        }
        args.push("-m".into());
        args.push(message.to_string());
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        let hash = git_at_date(&self.repo, &args, &date).trim().to_string();
        self.parents.insert(hash.clone(), parents.to_vec());
        hash
    }

    fn move_branch(&mut self, branch: &str, hash: &str) {
        self.repo
            .git(&["update-ref", &format!("refs/heads/{branch}"), hash]);
        self.heads.insert(branch.to_string(), hash.to_string());
    }

    fn commit_on_current(&mut self, message: &str) {
        let parent = self.heads[&self.current].clone();
        let hash = self.commit_tree(&[parent], message);
        self.move_branch(&self.current.clone(), &hash);
    }

    /// Perform one random operation, answering a description for failure messages.
    fn op(&mut self) -> String {
        match self.rng.below(100) {
            0..=29 => {
                let n = self.next_name();
                self.commit_on_current(&format!("commit {n}"));
                format!("commit {n}")
            }
            30..=39 => {
                let n = self.next_name();
                let name = format!("b{n}");
                let hash = self.heads[&self.current].clone();
                self.move_branch(&name, &hash);
                format!("branch {name}")
            }
            40..=47 => {
                let names: Vec<String> = self.heads.keys().cloned().collect();
                let name = self.rng.pick(&names).clone();
                self.repo
                    .git(&["symbolic-ref", "HEAD", &format!("refs/heads/{name}")]);
                self.current = name.clone();
                format!("checkout {name}")
            }
            48..=59 => {
                let n = self.next_name();
                let name = format!("t{n}");
                let hash = self.heads[&self.current].clone();
                if self.rng.chance(50) {
                    self.repo.git(&["tag", &name, &hash]);
                } else {
                    self.repo
                        .git(&["tag", "-a", &name, "-m", &format!("tag {n}"), &hash]);
                }
                format!("tag {name}")
            }
            60..=71 => {
                let others: Vec<String> = self
                    .heads
                    .keys()
                    .filter(|name| **name != self.current)
                    .cloned()
                    .collect();
                if others.is_empty() {
                    let n = self.next_name();
                    self.commit_on_current(&format!("commit {n}"));
                    return format!("commit {n}");
                }
                let other = self.rng.pick(&others).clone();
                if self.rng.chance(30) {
                    // A fast-forward: only a ref moves, no commit is created.
                    let hash = self.heads[&other].clone();
                    self.move_branch(&self.current.clone(), &hash);
                    format!("fast-forward {other} into {}", self.current)
                } else {
                    let a = self.heads[&self.current].clone();
                    let b = self.heads[&other].clone();
                    let hash = self.commit_tree(&[a, b], &format!("merge {other}"));
                    self.move_branch(&self.current.clone(), &hash);
                    format!("merge {other} into {}", self.current)
                }
            }
            72..=79 => {
                // Move the current branch some first-parents back: the commits above become
                // unreachable — the history rewrite the incremental cache must detect.
                let mut hash = self.heads[&self.current].clone();
                let mut moved = false;
                for _ in 0..(1 + self.rng.below(3)) {
                    match self.parents.get(&hash).and_then(|parents| parents.first()) {
                        Some(parent) => {
                            hash = parent.clone();
                            moved = true;
                        }
                        None => break,
                    }
                }
                if moved {
                    self.move_branch(&self.current.clone(), &hash);
                    format!("reset {} back", self.current)
                } else {
                    let n = self.next_name();
                    self.commit_on_current(&format!("commit {n}"));
                    format!("commit {n}")
                }
            }
            80..=91 => {
                // A simulated fetch: new commits arrive under a remote-tracking ref. One fetch
                // in five carries deliberately old dates — the fetched-branch case the date
                // dominance guard must reject.
                let n = self.next_name();
                let parent = self.heads[&self.current].clone();
                if self.rng.chance(20) {
                    self.clock -= 3660;
                }
                let hash = self.commit_tree(&[parent], &format!("fetched {n}"));
                self.repo
                    .git(&["update-ref", &format!("refs/remotes/origin/r{n}"), &hash]);
                format!("fetch r{n}")
            }
            _ => "reload only".to_string(),
        }
    }
}

/// Run one git command with the author and committer dates pinned, as the driver's commits need.
fn git_at_date(repo: &TestRepo, args: &[&str], date: &str) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo.path())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("HOME", repo.path())
        .env("GIT_AUTHOR_DATE", date)
        .env("GIT_COMMITTER_DATE", date)
        .output()
        .unwrap_or_else(|e| panic!("could not run `git {}`: {e}", args.join(" ")));
    assert!(
        output.status.success(),
        "`git {}` failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/* ---------- The property itself ---------- */

/// The options a default view load sends.
fn view_options(max_commits: u32, ordering: CommitOrdering) -> LogOptions {
    LogOptions {
        max_commits,
        show_tags: true,
        show_remote_branches: true,
        show_commits_only_referenced_by_tags: true,
        show_uncommitted_changes: true,
        show_untracked_files: true,
        commit_ordering: ordering,
        ..Default::default()
    }
}

fn to_json<T: Serialize>(value: &T) -> serde_json::Value {
    serde_json::to_value(value).unwrap()
}

/// The property: served from the cache (the loads a host refresh issues) the page must equal
/// the page of a full traversal (the cache invalidated first), under both orderings.
fn assert_matches_full(repo_path: &Path, date: &LogOptions, topo: &LogOptions, context: &str) {
    let engine = Repo::discover(repo_path).unwrap();
    let store = incremental::Store::global();
    let incremental_date = graph::load_commits(&engine, date, Cancel::none()).unwrap();
    let incremental_topo = graph::load_commits(&engine, topo, Cancel::none()).unwrap();
    store.invalidate(engine.root());
    let full_date = graph::load_commits(&engine, date, Cancel::none()).unwrap();
    let full_topo = graph::load_commits(&engine, topo, Cancel::none()).unwrap();
    assert_eq!(
        to_json(&incremental_date),
        to_json(&full_date),
        "{context}: the date-ordered page differs from a full traversal"
    );
    assert_eq!(
        to_json(&incremental_topo),
        to_json(&full_topo),
        "{context}: the topo-ordered page differs from a full traversal"
    );
}

/// One random case: a fresh fixture, `seed` driving every choice. Answers whether any step was
/// served from the cache (asserted in aggregate by the batch tests).
fn run_case(seed: u64) -> bool {
    let mut repo = TestRepo::new();
    repo.git(&[
        "remote",
        "add",
        "origin",
        "https://example.invalid/source.git",
    ]);
    repo.commit_file("seed.txt", "seed\n", "seed commit");
    let mut driver = Driver::new(repo, seed);

    let max_commits: u32 = [3, 7, 12, 40, 300][driver.rng.below(5) as usize];
    let date = view_options(max_commits, CommitOrdering::Date);
    let topo = view_options(max_commits, CommitOrdering::Topo);
    let store = incremental::Store::global();

    let steps = 6 + driver.rng.below(7);
    let mut any_hit = false;
    for step in 0..steps {
        let op = driver.op();
        let (hits_before, _) = store.stats();
        assert_matches_full(
            driver.repo.path(),
            &date,
            &topo,
            &format!("seed {seed}, step {step} ({op})"),
        );
        let (hits_after, _) = store.stats();
        any_hit |= hits_after > hits_before;
    }
    any_hit
}

/// How many cases each batch test runs; ten batches make 300 cases in total, and the batches
/// run in parallel the way the crate's other tests do.
const CASES_PER_BATCH: u64 = 30;

fn run_batch(batch: u64) {
    require_git!();
    let mut any_hit = false;
    for case in 0..CASES_PER_BATCH {
        any_hit |= run_case(batch * CASES_PER_BATCH + case);
    }
    assert!(
        any_hit,
        "batch {batch}: at least one refresh must be served from the cache"
    );
}

macro_rules! property_batch {
	($($name:ident = $batch:expr;)*) => {
		$(
			#[test]
			fn $name() {
				run_batch($batch);
			}
		)*
	};
}

property_batch! {
    random_sequences_batch_1 = 1;
    random_sequences_batch_2 = 2;
    random_sequences_batch_3 = 3;
    random_sequences_batch_4 = 4;
    random_sequences_batch_5 = 5;
    random_sequences_batch_6 = 6;
    random_sequences_batch_7 = 7;
    random_sequences_batch_8 = 8;
    random_sequences_batch_9 = 9;
    random_sequences_batch_10 = 10;
}

/* ---------- Deterministic scenarios ---------- */

#[test]
fn a_refresh_after_a_commit_is_answered_from_the_cache() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1\n", "one");
    repo.commit_file("a.txt", "2\n", "two");
    let engine = Repo::discover(repo.path()).unwrap();
    let options = view_options(300, CommitOrdering::Date);

    let first = graph::load_commits(&engine, &options, Cancel::none()).unwrap();
    let store = incremental::Store::global();
    let hits_before = store.stats().0;
    repo.commit_file("a.txt", "3\n", "three");
    let second = graph::load_commits(&engine, &options, Cancel::none()).unwrap();
    let hits_after = store.stats().0;
    assert!(
        hits_after > hits_before,
        "a refresh that only adds a commit on top is served from the cache"
    );

    // The answer is the previous page with the new commit prepended.
    assert_eq!(second.commits[0].hash, repo.head());
    assert_eq!(second.commits[0].parents, [first.commits[0].hash.clone()]);
    assert_eq!(second.commits[1].hash, first.commits[0].hash);
    assert_eq!(second.head.as_deref(), Some(repo.head().as_str()));

    // And it is exactly what a full traversal answers.
    store.invalidate(engine.root());
    let full = graph::load_commits(&engine, &options, Cancel::none()).unwrap();
    assert_eq!(to_json(&second), to_json(&full));
}

#[test]
fn a_reset_falls_back_to_a_full_traversal() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1\n", "one");
    repo.commit_file("a.txt", "2\n", "two");
    let stranded = repo.head();
    let engine = Repo::discover(repo.path()).unwrap();
    let options = view_options(300, CommitOrdering::Topo);
    graph::load_commits(&engine, &options, Cancel::none()).unwrap();

    repo.git(&["reset", "--hard", "HEAD~1"]);
    let store = incremental::Store::global();
    let fallbacks_before = store.stats().1;
    let after = graph::load_commits(&engine, &options, Cancel::none()).unwrap();
    let fallbacks_after = store.stats().1;
    assert!(
        fallbacks_after > fallbacks_before,
        "a refresh whose old tip is no longer reachable falls back to a full traversal"
    );

    // The stranded commit is gone: nothing of the cached window may leak into the page.
    assert_eq!(after.commits.len(), 1);
    assert_eq!(after.commits[0].hash, repo.head());
    assert!(after.commits.iter().all(|commit| commit.hash != stranded));

    store.invalidate(engine.root());
    let full = graph::load_commits(&engine, &options, Cancel::none()).unwrap();
    assert_eq!(to_json(&after), to_json(&full));
}

#[test]
fn annotate_re_labels_a_page_exactly_as_a_full_load() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1\n", "one");
    repo.git(&["tag", "v1"]);
    repo.git(&["checkout", "--quiet", "-b", "feature"]);
    let second = repo.commit_file("a.txt", "2\n", "feature work");
    repo.git(&["checkout", "--quiet", "main"]);
    let third = repo.commit_file("a.txt", "3\n", "main work");
    repo.add_fake_remote("origin", "feature", &second);
    repo.git(&["tag", "-a", "v2", "-m", "second", &second]);

    let engine = Repo::discover(repo.path()).unwrap();
    // The remotes the engine itself reads — `annotate` resolves remote ownership from the
    // repository, exactly as `Engine::graph` does; the comparison load is given the same list.
    let mut options = view_options(300, CommitOrdering::Date);
    options.remotes = engine.remote_names();
    let page = graph::load_commits(&engine, &options, Cancel::none()).unwrap();
    let hashes: Vec<String> = page
        .commits
        .iter()
        .map(|commit| commit.hash.clone())
        .collect();

    // A refs-only operation: the commits stay, the labels move.
    repo.git(&["branch", "moved", &third]);
    repo.git(&["update-ref", "refs/remotes/origin/feature", &third]);
    let annotated = graph::annotate(
        &engine,
        &AnnotateParams {
            commits: hashes,
            refs: RefOptions::default(),
            show_tags: true,
        },
    )
    .unwrap();

    assert_eq!(annotated.head.as_deref(), Some(third.as_str()));
    let fresh = graph::load_commits(&engine, &options, Cancel::none()).unwrap();
    // Every label field a full load attaches, in the same order — compared label by label so a
    // failure names the commit that differs.
    assert_eq!(annotated.commits.len(), fresh.commits.len());
    for (labels, commit) in annotated.commits.iter().zip(&fresh.commits) {
        assert_eq!(labels.hash, commit.hash);
        assert_eq!(
            to_json(&labels.heads),
            to_json(&commit.heads),
            "{}",
            labels.hash
        );
        assert_eq!(
            to_json(&labels.tags),
            to_json(&commit.tags),
            "{}",
            labels.hash
        );
        assert_eq!(
            to_json(&labels.remotes),
            to_json(&commit.remotes),
            "{}",
            labels.hash
        );
    }

    // The moved label really did move.
    let third_labels = annotated
        .commits
        .iter()
        .find(|labels| labels.hash == third)
        .unwrap();
    assert!(third_labels.heads.contains(&"moved".to_string()));
    assert!(third_labels
        .remotes
        .iter()
        .any(|remote| remote.name == "origin/feature"));
    let second_labels = annotated
        .commits
        .iter()
        .find(|labels| labels.hash == second)
        .unwrap();
    assert!(second_labels.heads.contains(&"feature".to_string()));
    assert!(!second_labels
        .remotes
        .iter()
        .any(|remote| remote.name == "origin/feature"));
}

#[test]
fn the_protocol_answers_refs_and_annotate() {
    require_git!();
    let mut repo = TestRepo::new();
    let first = repo.commit_file("a.txt", "1\n", "one");
    repo.git(&["tag", "v1"]);
    let second = repo.commit_file("a.txt", "2\n", "two");
    let root = repo.path().to_str().unwrap().to_string();

    // `refs` answers the same ref scan `loadRepoInfo` and `loadCommits` build on: the raw ref
    // data, plus the branch list, the checked-out branch and the tag names.
    let answer = ask(&root, "refs", serde_json::json!({}));
    assert_eq!(answer["branchHead"], serde_json::json!("main"));
    assert_eq!(answer["branches"], serde_json::json!(["main"]));
    assert_eq!(answer["tagNames"], serde_json::json!(["v1"]));
    assert_eq!(answer["refData"]["head"], serde_json::json!(&second));

    // `annotate` answers the labels of the page the host already holds.
    let answer = ask(
        &root,
        "annotate",
        serde_json::json!({ "commits": [&second, &first], "refs": {}, "showTags": true }),
    );
    assert_eq!(answer["head"], serde_json::json!(&second));
    assert_eq!(answer["commits"][0]["hash"], serde_json::json!(&second));
    assert_eq!(answer["commits"][0]["heads"], serde_json::json!(["main"]));
    assert_eq!(answer["commits"][1]["hash"], serde_json::json!(&first));
    assert_eq!(
        answer["commits"][1]["tags"],
        serde_json::json!([{"name": "v1", "annotated": false}])
    );
}

#[test]
fn load_view_answers_repo_info_and_commits_in_one_call() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1\n", "one");
    repo.git(&["tag", "v1"]);
    repo.git(&["checkout", "--quiet", "-b", "feature"]);
    repo.commit_file("a.txt", "2\n", "feature");
    repo.git(&["checkout", "--quiet", "main"]);

    let engine = Repo::discover(repo.path()).unwrap();
    let options = view_options(300, CommitOrdering::Date);
    let view = graph::load_view(&engine, &options, Cancel::none()).unwrap();
    let info = graph::repo_info(
        &engine,
        &RefReadOptions {
            show_remote_branches: true,
            ..Default::default()
        },
        true,
    )
    .unwrap();
    let page = graph::load_commits(&engine, &options, Cancel::none()).unwrap();
    assert_eq!(to_json(&view.info), to_json(&info));
    assert_eq!(to_json(&view.commits), to_json(&page));
}

#[test]
fn a_commit_graph_file_leaves_the_answers_unchanged() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_linear_history(50);
    repo.git(&["reset", "--hard", "HEAD"]);
    let engine = Repo::discover(repo.path()).unwrap();
    let options = view_options(20, CommitOrdering::Topo);

    let before = graph::load_commits(&engine, &options, Cancel::none()).unwrap();
    repo.git(&["commit-graph", "write", "--reachable"]);
    incremental::Store::global().invalidate(engine.root());
    let after = graph::load_commits(&engine, &options, Cancel::none()).unwrap();
    assert_eq!(
        to_json(&before),
        to_json(&after),
        "a commit-graph file changes no answer (gix reads it automatically)"
    );

    // The incremental path keeps working on top of a commit-graph file.
    repo.commit_file("a.txt", "tail\n", "one more");
    let refreshed = graph::load_commits(&engine, &options, Cancel::none()).unwrap();
    incremental::Store::global().invalidate(engine.root());
    let full = graph::load_commits(&engine, &options, Cancel::none()).unwrap();
    assert_eq!(to_json(&refreshed), to_json(&full));
}

/* ---------- Helpers ---------- */

/// The `ok` value of a protocol request that must succeed.
fn ask(repo_path: &str, method: &str, params: serde_json::Value) -> serde_json::Value {
    let request = serde_json::json!({ "method": method, "params": params }).to_string();
    let answer: serde_json::Value =
        serde_json::from_str(&protocol::request(repo_path, &request)).unwrap();
    answer
        .get("ok")
        .cloned()
        .unwrap_or_else(|| panic!("{method} failed: {answer}"))
}
