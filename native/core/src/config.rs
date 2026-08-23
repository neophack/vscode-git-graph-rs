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

use crate::error::{Error, ErrorKind, Result};
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
    // A remote name is a config subsection, which git allows to hold spaces, dots and more; the
    // name is only ever part of an in-process config lookup, so there is nothing to validate it
    // against beyond "not empty".
    if remote.is_empty() {
        return Err(Error::invalid_argument(
            "Invalid remote name was provided: (empty)",
        ));
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

/* ---------- The remaining reads the settings panel and dialogs make ---------- */

/// The names of the repository's remotes, as `git remote` lists them (alphabetical).
pub fn remote_names(repo: &Repo) -> Result<Vec<String>> {
    Ok(repo.remote_names())
}

/// The checked-out branch's short name, or `None` when HEAD is detached — the answer
/// `git symbolic-ref --short HEAD` gives (an unborn branch still has its name).
pub fn current_branch_name(repo: &Repo) -> Result<Option<String>> {
    let git = repo.borrow();
    Ok(git.head_name().ok().flatten().and_then(|name| {
        name.as_bstr()
            .strip_prefix(b"refs/heads/".as_slice())
            .map(|branch| String::from_utf8_lossy(branch).into_owned())
    }))
}

/// One location a configuration entry can live in, matching `git config --local` / `--global`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigLocation {
    Local,
    Global,
}

/// The configuration entries of one location, last value per key — the shape
/// `git config --list -z --includes --local|--global` is parsed into.
///
/// ### Deviation
///
/// A file carrying `include`/`includeIf` directives is declined (`Unsupported`) so the call
/// reaches the `git` CLI, which resolves them: replicating git's include resolution (including
/// conditional includes) is out of proportion to how rarely these appear in the local or the
/// user's global file.
pub fn config_list(
    repo: &Repo,
    location: ConfigLocation,
) -> Result<std::collections::BTreeMap<String, String>> {
    let path = match location {
        ConfigLocation::Local => repo.git_dir().join("config"),
        ConfigLocation::Global => global_config_path()?,
    };
    if !path.is_file() {
        // `git config --list --global` on a machine without the file fails, which the caller
        // has always treated as "no entries"; an absent local file means the same.
        return Ok(std::collections::BTreeMap::new());
    }

    let file = gix::config::File::from_path_no_includes(path, gix::config::Source::Local)
        .map_err(|e| Error::git(format!("Could not read the configuration: {e}")))?;
    if file.sections_by_name("include").is_some() || file.sections_by_name("includeif").is_some() {
        return Err(Error::unsupported(
            "The configuration file contains include directives",
        ));
    }

    let mut entries = std::collections::BTreeMap::new();
    for section in file.sections() {
        let header = section.header();
        let name = String::from_utf8_lossy(header.name()).to_lowercase();
        for key in section.value_names() {
            // A repeated key keeps its last value, which is git's own resolution; a section
            // seen later in the file overwrites an earlier one for the same full key.
            if let Some(value) = section.values(&key).pop() {
                let full_key = match header.subsection_name() {
                    Some(subsection) => {
                        format!("{name}.{}.{key}", String::from_utf8_lossy(subsection))
                    }
                    None => format!("{name}.{key}"),
                };
                entries.insert(full_key, value.to_string());
            }
        }
    }
    Ok(entries)
}

/// The file the `--global` location resolves to: `$GIT_CONFIG_GLOBAL` when set, else the user's
/// `~/.gitconfig`, else the XDG one — git's own order.
fn global_config_path() -> Result<std::path::PathBuf> {
    use std::path::PathBuf;
    if let Ok(explicit) = std::env::var("GIT_CONFIG_GLOBAL") {
        if !explicit.is_empty() {
            return Ok(PathBuf::from(explicit));
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| Error::new(ErrorKind::Io, "Neither HOME nor USERPROFILE is set"))?;
    let home_config = PathBuf::from(&home).join(".gitconfig");
    if home_config.is_file() {
        return Ok(home_config);
    }
    let xdg = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(home).join(".config"));
    Ok(xdg.join("git").join("config"))
}
