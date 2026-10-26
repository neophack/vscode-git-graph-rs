#![no_main]

//! Fuzz the protocol request decoder — the JSON boundary every host request crosses.
//!
//! This is the same entry function the always-on property tests drive
//! (`native/core/tests/fuzz_boundary.rs`): a hostile byte stream enters exactly as host JSON
//! would — as a UTF-8 string — and must come back as a typed request or a structured error,
//! never a panic. A panic here is caught by `catch_unwind` at the N-API layer, but it would
//! still surface to the user as a silent CLI fallback.

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let request = String::from_utf8_lossy(data);
    let _ = git_graph_core::protocol::decode_request(&request);
});
