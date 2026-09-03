//! Fixture repositories, built with the `git` command line.
//!
//! Git is the reference implementation, so comparing against what git itself reports for the same
//! question is the strongest correctness signal available. This is the *only* place `git` is run:
//! nothing in the shipped engine ever spawns a process.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;

pub struct TestRepo {
    dir: TempDir,
    /// Commits get distinct, increasing timestamps so that date ordering is deterministic rather
    /// than depending on how fast the test machine runs.
    clock: i64,
}

impl TestRepo {
    /// Create an empty repository with a deterministic identity and configuration.
    pub fn new() -> TestRepo {
        let dir = tempfile::tempdir().expect("could not create a temporary directory");
        let repo = TestRepo {
            dir,
            clock: 1_600_000_000,
        };
        repo.git(&["init", "--quiet", "--initial-branch=main"]);
        repo.git(&["config", "user.name", "Test User"]);
        repo.git(&["config", "user.email", "test@example.com"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo.git(&["config", "gc.auto", "0"]);
        repo
    }

    /// Create an empty repository whose refs are stored in a non-default backend, when the local
    /// git supports it (`git init --ref-format=` arrived in git 2.45).
    pub fn new_with_ref_format(ref_format: &str) -> TestRepo {
        let dir = tempfile::tempdir().expect("could not create a temporary directory");
        let repo = TestRepo {
            dir,
            clock: 1_600_000_000,
        };
        repo.git(&[
            "init",
            "--quiet",
            "--initial-branch=main",
            "--ref-format",
            ref_format,
        ]);
        repo.git(&["config", "user.name", "Test User"]);
        repo.git(&["config", "user.email", "test@example.com"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo.git(&["config", "gc.auto", "0"]);
        repo
    }

    pub fn path(&self) -> &Path {
        self.dir.path()
    }

    /// Run a git command in the repository, asserting that it succeeded.
    pub fn git(&self, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(self.path())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("HOME", self.path())
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

    /// Run a git command and return its output whether or not it succeeded.
    pub fn git_allow_failure(&self, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(self.path())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", self.path())
            .output()
            .unwrap_or_else(|e| panic!("could not run `git {}`: {e}", args.join(" ")));
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    pub fn write(&self, path: &str, contents: &str) {
        let full = self.path().join(path);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).expect("could not create the parent directory");
        }
        std::fs::write(full, contents).expect("could not write the file");
    }

    pub fn remove(&self, path: &str) {
        std::fs::remove_file(self.path().join(path)).expect("could not remove the file");
    }

    /// Commit every change in the working tree, at the next tick of the fixture clock.
    pub fn commit(&mut self, message: &str) -> String {
        self.git(&["add", "-A"]);
        self.commit_at(message)
    }

    fn commit_at(&mut self, message: &str) -> String {
        self.clock += 60;
        let date = format!("{} +0000", self.clock);
        let output = Command::new("git")
            .args(["commit", "--quiet", "--allow-empty", "-m", message])
            .current_dir(self.path())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", self.path())
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .output()
            .expect("could not run `git commit`");
        assert!(
            output.status.success(),
            "`git commit` failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        self.head()
    }

    /// Write a file and commit it in one step.
    pub fn commit_file(&mut self, path: &str, contents: &str, message: &str) -> String {
        self.write(path, contents);
        self.commit(message)
    }

    pub fn head(&self) -> String {
        self.git(&["rev-parse", "HEAD"]).trim().to_string()
    }

    pub fn rev_parse(&self, revision: &str) -> String {
        self.git(&["rev-parse", revision]).trim().to_string()
    }

    /// The hashes `git log` reports for the given arguments — the expected answer.
    pub fn log_hashes(&self, args: &[&str]) -> Vec<String> {
        let mut all = vec!["log", "--format=%H"];
        all.extend_from_slice(args);
        self.git(&all).lines().map(str::to_string).collect()
    }

    /// Turn the repository into one that looks like it has a remote, without any network: the
    /// remote-tracking refs are written directly.
    pub fn add_fake_remote(&self, name: &str, branch: &str, hash: &str) {
        self.git(&["remote", "add", name, "https://example.invalid/repo.git"]);
        self.git(&["update-ref", &format!("refs/remotes/{name}/{branch}"), hash]);
    }

    pub fn update_ref(&self, name: &str, hash: &str) {
        self.git(&["update-ref", name, hash]);
    }
}

/// Is `git` available? The fixtures cannot be built without it.
pub fn git_available() -> bool {
    Command::new("git")
        .arg("--version")
        .output()
        .is_ok_and(|out| out.status.success())
}

/// Skip a test when git is unavailable, rather than failing on a machine that cannot run it.
///
/// Exported with `#[macro_use]` on the module rather than `#[macro_export]`, so that the path it
/// expands to is unambiguous: the fixtures are only ever used from this crate's own tests.
macro_rules! require_git {
    () => {
        if !common::git_available() {
            eprintln!("skipping: `git` is not available");
            return;
        }
    };
}

pub fn repo_root(repo: &TestRepo) -> PathBuf {
    repo.path().to_path_buf()
}
