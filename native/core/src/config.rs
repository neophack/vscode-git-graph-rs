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

use crate::error::Result;
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
