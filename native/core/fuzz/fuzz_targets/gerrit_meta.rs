#![no_main]

//! Fuzz the pure Gerrit `NoteDb` meta message parser — the grammar the view runs over meta
//! histories fetched from a Gerrit server's repository.
//!
//! This is the same entry function the always-on property tests drive
//! (`native/core/tests/fuzz_boundary.rs`). All three parser inputs are attacker-controlled:
//! the first 8 bytes name the meta commit's timestamp, the bytes up to the first NUL name
//! its committer, and the rest is the message — the same `(committer, timestamp, message)`
//! triple the engine reads from a repository's meta ref. A panic here is caught by
//! `catch_unwind` at the N-API layer, but it would still surface to the user as a silent
//! CLI fallback.

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let (timestamp, rest) = if data.len() >= 8 {
        let mut bytes = [0u8; 8];
        bytes.copy_from_slice(&data[..8]);
        (i64::from_le_bytes(bytes), &data[8..])
    } else {
        (1_600_000_000, data)
    };
    let split = rest.iter().position(|byte| *byte == 0).unwrap_or(rest.len());
    let committer = String::from_utf8_lossy(&rest[..split]);
    let message = String::from_utf8_lossy(&rest[split..]);
    let _ = git_graph_core::parse_gerrit_meta_message(&committer, timestamp, &message);
});
