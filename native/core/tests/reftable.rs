//! Repositories that store their refs in the reftable format.
//!
//! gitoxide reads only the files backend (loose refs and `packed-refs`), so a reftable repository
//! would open cleanly yet report no branches and no commits — an empty graph indistinguishable
//! from an empty repository, which is exactly what a user of `git init --ref-format=reftable`
//! used to see. The engine must decline such a repository as `Unsupported`, which the extension
//! turns into a transparent fallback to the `git` CLI (git itself reads reftable natively).

#[macro_use]
mod common;

use git_graph_core::error::ErrorKind;
use git_graph_core::repository::Repo;

use std::process::Command;

use common::TestRepo;

/// Does the local `git` understand `--ref-format`? (git 2.45 and newer.)
fn ref_formats_supported() -> bool {
    let dir = tempfile::tempdir().expect("could not create a temporary directory");
    Command::new("git")
        .args(["init", "--quiet", "--ref-format=reftable"])
        .current_dir(dir.path())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .is_ok_and(|out| out.status.success())
}

#[test]
fn a_reftable_repository_is_declined_as_unsupported() {
    require_git!();
    if !ref_formats_supported() {
        eprintln!("skipping: this git does not support --ref-format");
        return;
    }

    let mut repo = TestRepo::new_with_ref_format("reftable");
    repo.commit_file("a.txt", "1", "first commit");

    // The fixture is a real repository with a real branch: git itself reads it fine.
    let head = repo.rev_parse("refs/heads/main");
    assert_eq!(head, repo.head());

    let error = match Repo::discover(repo.path()) {
        Err(error) => error,
        Ok(_) => {
            panic!("the engine must decline a reftable repository instead of showing it empty")
        }
    };
    assert_eq!(error.kind, ErrorKind::Unsupported);
}

#[test]
fn a_files_repository_is_not_mistaken_for_reftable() {
    require_git!();
    let mut repo = TestRepo::new();
    repo.commit_file("a.txt", "1", "first commit");

    // A plain files-backend repository opens exactly as before, including one with packed refs.
    repo.git(&["pack-refs", "--all"]);
    Repo::discover(repo.path()).expect("a files repository must still open");
}
