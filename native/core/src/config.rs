//! Repository configuration, as `git config` resolves it.
//!
//! The view needs a handful of settings (the identity, the remotes, the diff tools) and the
//! original extension read each of them with its own `git config` process. Here one pass over
//! the already-materialised config stack answers all of them at once.
//!
//! The stack gix keeps open is local + global + system, with the same precedence git applies,
//! so `snapshot.string(...)` already resolves to the value git itself would use. The remotes
//! are the one part that needs manual ordering: sections are visited in the order the files
//! declare them, which is what `git remote` effectively lists.

use std::path::Path;

use crate::error::{Error, Result};
use crate::repository::Repo;
use crate::types::{ConfigSnapshot, RemoteConfig};

/// Read the configuration values the view shows.
pub fn read_config(repo: &Repo) -> Result<ConfigSnapshot> {
    let git = repo.borrow();
    let config = git.config_snapshot();

    // A remote may be declared across several config files (e.g. a URL locally and a push URL
    // globally); the first section wins for each field, which is git's own last-wins resolution
    // flipped to section order, so remotes already seen are skipped.
    let mut remotes: Vec<RemoteConfig> = Vec::new();
    if let Some(sections) = config.plumbing().sections_by_name("remote") {
        for section in sections {
            let Some(name) = section.header().subsection_name() else {
                continue;
            };
            if remotes.iter().any(|remote| remote.name == name) {
                continue;
            }
            remotes.push(RemoteConfig {
                name: name.to_string(),
                url: section.value("url").map(|v| v.to_string()),
                push_url: section.value("pushurl").map(|v| v.to_string()),
            });
        }
    }

    let string = |key: &str| config.string(key).map(|v| v.to_string());
    Ok(ConfigSnapshot {
        remotes,
        user_name: string("user.name"),
        user_email: string("user.email"),
        push_default: string("remote.pushdefault"),
        diff_tool: string("diff.tool"),
        diff_gui_tool: string("diff.guitool"),
    })
}

/// The fetch URL of one remote, or `None` when the remote (or its URL) is not configured —
/// the answer `git config --get remote.<name>.url` gives.
pub fn remote_url(repo: &Repo, remote: &str) -> Result<Option<String>> {
    if !is_safe_config_name(remote) {
        return Err(Error::invalid_argument(format!(
            "Invalid remote name was provided: {remote}"
        )));
    }
    let git = repo.borrow();
    Ok(git
        .config_snapshot()
        .string(format!("remote.{remote}.url").as_str())
        .map(|value| value.to_string()))
}

/// The upstream of the checked-out branch, short-spelled as `git rev-parse --abbrev-ref
/// --symbolic-full-name @{upstream}` prints it (`origin/main`), or `None` when there is none.
pub fn current_branch_upstream(repo: &Repo) -> Result<Option<String>> {
    let git = repo.borrow();
    let branch = git.head_name().ok().flatten().and_then(|name| {
        name.as_bstr()
            .strip_prefix(b"refs/heads/".as_slice())
            .map(|branch| String::from_utf8_lossy(branch).into_owned())
    });
    let Some(branch) = branch else {
        // Detached HEAD tracks nothing.
        return Ok(None);
    };

    let config = git.config_snapshot();
    let string = |key: String| config.string(key.as_str()).map(|value| value.to_string());
    let remote = string(format!("branch.{branch}.remote"));
    let merge = string(format!("branch.{branch}.merge"));
    let (remote, merge) = match (remote, merge) {
        (Some(remote), Some(merge)) => (remote, merge),
        _ => return Ok(None),
    };

    // `remote = .` means the upstream is local: the merge ref itself is the branch followed.
    let short = merge
        .strip_prefix("refs/heads/")
        .unwrap_or(&merge)
        .to_string();
    Ok(Some(if remote == "." {
        short
    } else {
        format!("{remote}/{short}")
    }))
}

/// The roots of the repository's initialised submodules, as the original extension gathered them
/// from `.gitmodules`.
///
/// A submodule that was never initialised has no repository of its own below its path, so it is
/// skipped — the original resolved each path's repository root and dropped the ones without one.
pub fn submodules(repo: &Repo) -> Result<Vec<String>> {
    if repo.is_bare() {
        return Ok(Vec::new());
    }
    let modules = repo.root().join(".gitmodules");
    if !modules.is_file() {
        return Ok(Vec::new());
    }

    let file =
        gix::config::File::from_path_no_includes(modules.clone(), gix::config::Source::Worktree)
            .map_err(|e| Error::git(format!("Could not read .gitmodules: {e}")))?;

    let mut roots: Vec<String> = Vec::new();
    if let Some(sections) = file.sections_by_name("submodule") {
        for section in sections {
            let Some(path) = section.value("path").map(|v| v.to_string()) else {
                continue;
            };
            let Some(root) = submodule_root(repo.root(), &path) else {
                continue;
            };
            if !roots.contains(&root) {
                roots.push(root);
            }
        }
    }
    Ok(roots)
}

/// The repository root of one submodule path, or `None` when the submodule is not initialised.
fn submodule_root(root: &Path, path: &str) -> Option<String> {
    // A `.git` below the path is what marks a submodule as initialised (a directory, or the gitfile
    // a submodule cloned with `git submodule` writes).
    let dir = root.join(path);
    if !dir.join(".git").exists() {
        return None;
    }
    let canonical = std::fs::canonicalize(&dir).ok()?;
    // Windows prefixes canonical paths with `\\?\`, which nothing comparing these strings expects.
    let text = canonical.display().to_string();
    Some(text.strip_prefix(r"\\?\").unwrap_or(&text).to_string())
}

/// Config subsection names are one dotted path component: no separators, no leading `-` (which
/// could turn the name into an option), no whitespace.
fn is_safe_config_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && !name.chars().any(|c| c.is_whitespace() || c == '\0')
        && !name.contains("..")
}
