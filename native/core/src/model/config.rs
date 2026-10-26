//! The configuration model: the settings the graph reads, and the repository's remotes.

use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnapshot {
    pub remotes: Vec<RemoteConfig>,
    pub user_name: Option<String>,
    pub user_email: Option<String>,
    pub push_default: Option<String>,
    pub diff_tool: Option<String>,
    pub diff_gui_tool: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfig {
    pub name: String,
    pub url: Option<String>,
    pub push_url: Option<String>,
}
