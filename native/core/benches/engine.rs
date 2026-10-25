//! Engine microbenchmarks (refactor plan, task 2.11) over generated fixtures.
//!
//! What is measured, per fixture size — S is 1k commits, M is 10k (a 100k fixture is generated
//! just as fast by `git fast-import`, but its bench runtime belongs to CI, not a laptop):
//!
//! - `traversal/first_page` — a cold-cache load of the first 300 commits. The incremental cache
//!   is invalidated every iteration, so this is the walk itself.
//! - `traversal/load_more` — the same, for a 900-commit page (what "Load More" asks for).
//! - `traversal/incremental_refresh` — the §3.8.3 refresh: one commit arrived on top of the
//!   cached traversal. The ref move and the restore run outside the timed section; the timed
//!   call is the load the host issues.
//! - `loadView`, `refs`, `commitDetails`, `status`, `statistics/*` — the other read paths the
//!   P1 gate tracks.
//!
//! Run: `cargo bench -p git-graph-core`. Absolute numbers are meaningless outside CI's
//! fixed machine; the gate compares runs against the baseline commit there.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use criterion::{criterion_group, criterion_main, Criterion};
use git_graph_core::engine::{Engine, GraphOptions};
use git_graph_core::IncrementalStore;

/* ---------- The fixtures ---------- */

/// A generated repository: `commits` linear commits, a clean working tree, optionally a
/// commit-graph file, and one unreferenced commit sitting on top of the tip — the arrival the
/// incremental-refresh benchmark moves the branch to.
struct Fixture {
    dir: tempfile::TempDir,
    tip: String,
    extra: String,
}

impl Fixture {
    fn build(label: &str, commits: usize, commit_graph: bool) -> Fixture {
        let dir = tempfile::tempdir().expect("could not create a temporary directory");
        let git = |args: &[&str]| run_git(dir.path(), args, None);
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "user.name", "Bench User"]);
        git(&["config", "user.email", "bench@example.invalid"]);
        git(&["config", "commit.gpgsign", "false"]);
        git(&["config", "gc.auto", "0"]);

        std::fs::write(dir.path().join("a.txt"), "seed\n").unwrap();
        git(&["add", "a.txt"]);
        // Dated at the base of the generated history's clock, so everything the fixture builds
        // afterwards lands monotonically after it — date ordering, and the incremental cache's
        // dominance guard, depend on that.
        run_git(
            dir.path(),
            &["commit", "--quiet", "--allow-empty", "-m", "seed"],
            Some("1600000000 +0000"),
        );

        // The base the generated history continues from.
        let head = git(&["rev-parse", "HEAD"]).trim().to_string();
        fast_import(dir.path(), commits, &head);
        // `fast-import` does not touch the working tree; this restores a clean status scan.
        git(&["reset", "--hard", "HEAD"]);
        if commit_graph {
            git(&["commit-graph", "write", "--reachable"]);
        }

        let tip = git(&["rev-parse", "HEAD"]).trim().to_string();
        let tree = git(&["rev-parse", "HEAD^{tree}"]).trim().to_string();
        // Dated after everything the fixture generated, so the arrival sits on top date-wise.
        let date = format!("{} +0000", 1_600_000_000 + 60 * (commits as i64 + 10));
        let extra = run_git(
            dir.path(),
            &["commit-tree", &tree, "-p", "HEAD", "-m", "bench refresh"],
            Some(&date),
        )
        .trim()
        .to_string();
        eprintln!("built the {label} fixture: {commits} commits");
        Fixture { dir, tip, extra }
    }
}

/// `git fast-import` a linear history on top of `from`, every commit dated one minute after the
/// last, so the walk order is stable whatever the machine's speed.
fn fast_import(dir: &Path, count: usize, from: &str) {
    // A `commit` with no `from` of its own continues the branch as the stream last left it, so
    // the stream opens by resetting the branch onto the fixture's seed commit explicitly.
    let mut stream = format!("reset refs/heads/main\nfrom {from}\n");
    for i in 0..count {
        let message = format!("commit {i}\n");
        let contents = format!("contents {i:08}\n");
        let seconds = 1_600_000_000 + 60 * (i as i64 + 1);
        stream.push_str(&format!(
            "commit refs/heads/main\n\
			 committer Bench User <bench@example.invalid> {seconds} +0000\n\
			 data {}\n{message}\
			 M 100644 inline a.txt\n\
			 data {}\n{contents}",
            message.len(),
            contents.len(),
        ));
    }
    let mut child = Command::new("git")
        .args(["fast-import", "--quiet"])
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("HOME", dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("could not run `git fast-import`");
    child
        .stdin
        .as_mut()
        .expect("fast-import asked for no stdin")
        .write_all(stream.as_bytes())
        .expect("could not feed `git fast-import`");
    let output = child
        .wait_with_output()
        .expect("could not wait for fast-import");
    assert!(
        output.status.success(),
        "`git fast-import` failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn run_git(dir: &Path, args: &[&str], date: Option<&str>) -> String {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("HOME", dir);
    if let Some(date) = date {
        command
            .env("GIT_AUTHOR_DATE", date)
            .env("GIT_COMMITTER_DATE", date);
    }
    let output = command
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

/* ---------- The benchmarks ---------- */

/// The options a default view load sends.
fn view_options(max_commits: u32) -> GraphOptions {
    GraphOptions {
        max_commits,
        ..Default::default()
    }
}

fn bench_engine(c: &mut Criterion) {
    let sizes = [("S_1k", 1_000usize), ("M_10k", 10_000)];
    for (label, commits) in sizes {
        let fixture = Fixture::build(label, commits, false);
        let engine = Engine::open(fixture.dir.path()).expect("could not open the fixture");
        let store = IncrementalStore::global();
        let first_page = view_options(300);
        let more = view_options(900);

        c.bench_function(&format!("traversal/first_page/{label}"), |b| {
            b.iter(|| {
                store.invalidate(engine.root());
                engine.graph(&first_page).unwrap()
            })
        });
        c.bench_function(&format!("traversal/load_more/{label}"), |b| {
            b.iter(|| {
                store.invalidate(engine.root());
                engine.graph(&more).unwrap()
            })
        });
        c.bench_function(&format!("traversal/incremental_refresh/{label}"), |b| {
            // The state every iteration refreshes FROM: a full traversal of [main -> tip].
            run_git(
                fixture.dir.path(),
                &["update-ref", "refs/heads/main", &fixture.tip],
                None,
            );
            store.invalidate(engine.root());
            engine.graph(&first_page).unwrap();

            // Prove the timed load really goes the incremental way before measuring it.
            let hits_before = store.stats().0;
            run_git(
                fixture.dir.path(),
                &["update-ref", "refs/heads/main", &fixture.extra],
                None,
            );
            engine.graph(&first_page).unwrap();
            let served = store.stats().0 - hits_before;
            assert!(
                served >= 1,
                "the refresh benchmark must exercise the incremental path"
            );
            run_git(
                fixture.dir.path(),
                &["update-ref", "refs/heads/main", &fixture.tip],
                None,
            );
            store.invalidate(engine.root());
            engine.graph(&first_page).unwrap();

            b.iter_custom(|iters| {
                let mut timed = Duration::ZERO;
                for _ in 0..iters {
                    // The arrival (untimed): one new commit on top of the cached traversal.
                    run_git(
                        fixture.dir.path(),
                        &["update-ref", "refs/heads/main", &fixture.extra],
                        None,
                    );
                    let start = Instant::now();
                    engine.graph(&first_page).unwrap();
                    timed += start.elapsed();
                    // The restore (untimed): move back and re-walk in full, so the next
                    // iteration advances onto the same arrival from a fresh traversal again.
                    run_git(
                        fixture.dir.path(),
                        &["update-ref", "refs/heads/main", &fixture.tip],
                        None,
                    );
                    store.invalidate(engine.root());
                    engine.graph(&first_page).unwrap();
                }
                timed
            })
        });
        c.bench_function(&format!("loadView/{label}"), |b| {
            b.iter(|| {
                store.invalidate(engine.root());
                engine.view(&first_page).unwrap()
            })
        });
        c.bench_function(&format!("refs/{label}"), |b| {
            b.iter(|| engine.refs(&first_page).unwrap())
        });
        c.bench_function(&format!("commitDetails/{label}"), |b| {
            b.iter(|| engine.commit(&fixture.tip).unwrap())
        });
        c.bench_function(&format!("status/{label}"), |b| {
            b.iter(|| engine.status().unwrap())
        });
        c.bench_function(&format!("statistics/authorStats/{label}"), |b| {
            b.iter(|| engine.author_stats().unwrap())
        });
        c.bench_function(&format!("statistics/activityHeatmap/{label}"), |b| {
            b.iter(|| engine.activity().unwrap())
        });
    }

    // The commit-graph comparison of task 2.10: the same first-page traversal, with the
    // repository carrying a commit-graph file (gix reads it automatically) and without.
    let plain = Fixture::build("M_10k (no commit-graph)", 10_000, false);
    let with_graph = Fixture::build("M_10k (commit-graph)", 10_000, true);
    let first_page = view_options(300);
    for (label, fixture) in [
        ("without_commit_graph", &plain),
        ("with_commit_graph", &with_graph),
    ] {
        let engine = Engine::open(fixture.dir.path()).unwrap();
        let store = IncrementalStore::global();
        c.bench_function(&format!("traversal/first_page/{label}/M_10k"), |b| {
            b.iter(|| {
                store.invalidate(engine.root());
                engine.graph(&first_page).unwrap()
            })
        });
    }
}

criterion_group! {
    name = benches;
    config = Criterion::default();
    targets = bench_engine
}
criterion_main!(benches);
