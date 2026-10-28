//! Always-on boundary fuzzing: deterministic, seeded property tests
//! that drive the two hostile-input decoders of the engine and assert the one property that
//! matters at the boundary — a panic on any input is a bug, because `catch_unwind` at the
//! N-API layer would turn it into a silent CLI fallback.
//!
//! Two targets:
//!
//! - `git_graph_core::protocol::decode_request` — the JSON `{"method", "params"}` contract
//!   every host request crosses. Inputs are pseudo-random JSON of many shapes (real and bogus
//!   methods, missing/wrong-typed parameters, out-of-range numbers, deep nesting, control
//!   characters) plus raw byte soup.
//! - `git_graph_core::parse_gerrit_meta_message` — the pure `NoteDb` meta message grammar.
//!   Inputs are pseudo-random text, character-level mutations of messages real Gerrit writes,
//!   and synthesized header/footer combinations with hostile numbers.
//!
//! The runs are deterministic: a fixed `splitmix64` seed per target expands into the byte
//! buffers that `arbitrary::Unstructured` consumes, so a failure reproduces exactly. On a
//! panic the test's failure message prints the seed, the iteration and the reproducing input.
//! `VGR_FUZZ_ITERATIONS` raises the iteration count for a deeper local run without touching
//! the default (a few hundred per target, so `cargo test` stays fast).
//!
//! The cargo-fuzz targets under `native/core/fuzz/` exercise the same two entry functions
//! with truly arbitrary bytes; this file is the regression net that runs on every `cargo
//! test` on every platform. Any crash found by either mechanism is committed as a fixed
//! regression test here, with the minimal reproducing input.

use arbitrary::{Arbitrary, Unstructured};
use std::panic::{catch_unwind, AssertUnwindSafe};

use git_graph_core::parse_gerrit_meta_message;
use git_graph_core::protocol;

/// The default iteration count per target: enough to cover the input shapes below many times
/// over, cheap enough that `cargo test --workspace` never notices.
const DEFAULT_ITERATIONS: usize = 512;

/// The fixed seeds. Chosen once; never changed, or old crash reports stop reproducing.
const SEED_PROTOCOL: u64 = 0x00F0_00D5_EED0_0001;
const SEED_GERRIT: u64 = 0x00F0_00D5_EED0_0002;

/// How deep the fixed attack nesting goes: past `serde_json`'s recursion limit of 128, so the
/// decoder must answer a clean error rather than fall over.
const ATTACK_DEPTH: usize = 200;

/// The iteration count for every target in this process, overridable for a deeper local run.
fn iterations() -> usize {
    std::env::var("VGR_FUZZ_ITERATIONS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_ITERATIONS)
}

/// A tiny deterministic PRNG (`splitmix64`). `arbitrary` turns its output into structured
/// inputs; nothing else in this file may consume randomness, so a seed names one exact input
/// sequence on every platform and every release of this crate.
struct SplitMix64(u64);

impl SplitMix64 {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// The next `len` pseudo-random bytes, little-endian chunks of [`SplitMix64::next_u64`].
    fn bytes(&mut self, len: usize) -> Vec<u8> {
        let mut bytes = vec![0u8; len];
        for chunk in bytes.chunks_mut(8) {
            chunk.copy_from_slice(&self.next_u64().to_le_bytes()[..chunk.len()]);
        }
        bytes
    }
}

/// Run one input against one target, asserting it does not panic.
///
/// The panic is caught so the failure can name the reproducing input: the seeds are fixed
/// constants, so rerunning this test hits the same case at the same iteration, and the input
/// itself goes straight into a regression test.
fn assert_unpanicked(
    target: &str,
    seed: u64,
    iteration: usize,
    input: &str,
    run: impl FnOnce(&str),
) {
    let outcome = catch_unwind(AssertUnwindSafe(|| run(input)));
    if outcome.is_err() {
        panic!(
            "{target} panicked on hostile input (seed {seed:#018x}, iteration {iteration}).\n\
             Rerun `cargo test -p git-graph-core --test fuzz_boundary` to reproduce exactly.\n\
             Commit a fixed regression test with the minimal input below:\n{input:?}"
        );
    }
}

/// One pseudo-random input round: expand `seed`'s stream into a byte buffer, build an input
/// with `generate`, and hand it to `run`. A generation that runs out of entropy mid-shape is
/// fine — the buffer was simply too small for that shape, and the next round draws a new one.
fn run_round(
    target: &str,
    seed: u64,
    iteration: usize,
    run: impl Fn(&str),
    generate: impl Fn(&mut Unstructured<'_>) -> Option<String>,
) {
    let mut rng = SplitMix64(seed ^ (iteration as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15));
    let length = 1 + (rng.next_u64() as usize) % 512;
    let buffer = rng.bytes(length);
    let mut unstructured = Unstructured::new(&buffer);
    if let Some(input) = generate(&mut unstructured) {
        assert_unpanicked(target, seed, iteration, &input, run);
    }
}

/// Character-level mutations of a seed string: deletes, duplications and arbitrary
/// insertions, all at char boundaries so generation itself cannot panic.
fn mutate_chars(unstructured: &mut Unstructured<'_>, seed: &str) -> Option<String> {
    let mut chars: Vec<char> = seed.chars().collect();
    for _ in 0..unstructured.int_in_range(1..=4usize).ok()? {
        if chars.is_empty() {
            break;
        }
        let position = unstructured.choose_index(chars.len()).ok()?;
        match unstructured.int_in_range::<u8>(0..=2).ok()? {
            0 => {
                chars.remove(position);
            }
            1 => {
                let inserted = unstructured.arbitrary::<char>().ok()?;
                chars.insert(position, inserted);
            }
            _ => {
                chars[position] = unstructured.arbitrary::<char>().ok()?;
            }
        }
    }
    Some(chars.into_iter().collect())
}

/* ---------- Target 1: the protocol request decoder ---------- */

/// JSON numbers chosen to attack integer decoding: the `i64` and `u64` limits, one past them,
/// and floats that cannot be an exact integer.
const ATTACK_NUMBERS: &[&str] = &[
    "0",
    "-0",
    "1",
    "-1",
    "2147483647",
    "2147483648",
    "9223372036854775807",
    "-9223372036854775808",
    "9223372036854775808",
    "-9223372036854775809",
    "18446744073709551615",
    "-18446744073709551616",
    "1.5",
    "-1.5",
    "1e300",
    "1e-300",
    "0.000000000000000000000001",
];

/// JSON text that is valid or invalid in specifically unpleasant ways: control characters,
/// escapes `serde_json` must reject, duplicate keys, and envelope shapes around them.
const ATTACK_JSON: &[&str] = &[
    "",
    " ",
    "null",
    "true",
    "42",
    "\"a plain string\"",
    "[[[[[[[",
    "{\"method\":null}",
    "{\"method\":42}",
    "{\"method\":[]}",
    "{\"method\":{}}",
    "{\"method\":\"engineVersion\"}",
    "{\"method\":\"engineVersion\",\"params\":null}",
    "{\"method\":\"engineVersion\",\"params\":42}",
    "{\"method\":\"engineVersion\",\"params\":[]}",
    "{\"method\":\"engineVersion\",\"extra\":1}",
    "{\"method\":\"engineVersion\",\"method\":\"status\",\"params\":{}}",
    "{\"method\":\"parseGerritMetas\",\"params\":{\"remote\":\"o\",\"changes\":null}}",
    "{\"method\":\"parseGerritMetas\",\"params\":{\"remote\":[],\"changes\":[]}}",
    "{\"method\":\"parseGerritMetas\",\"params\":{\"remote\":\"o\",\"changes\":[1,1.5,18446744073709551615,-9223372036854775809]}}",
    "{\"method\":\"\\ud800 lone surrogate\"}",
    "{\"method\":\"\\x41 bad escape\"}",
    "{\"method\":\"engineVersion\",\"params\":{\"deep\":\"\u{0}\u{1}\u{7f}\u{10FFFF}\"}}",
    "{\"method\":\"engineVersion\",\"params\":{\"a\":1,\"a\":2}}",
];

/// Valid requests of the wire shapes real methods take, for mutation.
const VALID_REQUESTS: &[&str] = &[
    "{\"method\":\"engineVersion\",\"params\":{}}",
    "{\"method\":\"status\",\"params\":{}}",
    "{\"method\":\"configList\",\"params\":{\"local\":true}}",
    "{\"method\":\"countUncommittedChanges\",\"params\":{\"includeUntracked\":false}}",
    "{\"method\":\"parseGerritMetas\",\"params\":{\"remote\":\"origin\",\"changes\":[1,2,41466],\"urlBase\":\"https://gerrit.example/c/\"}}",
    "{\"method\":\"loadCommits\",\"params\":{\"limit\":100}}",
    "{\"method\":\"fileContents\",\"params\":{\"revision\":\"HEAD\",\"path\":\"README.md\"}}",
];

/// A wire name from the engine's own method table.
fn real_method(unstructured: &mut Unstructured<'_>) -> Option<&'static str> {
    protocol::METHODS
        .get(unstructured.choose_index(protocol::METHODS.len()).ok()?)
        .copied()
}

/// An arbitrary JSON value, depth-capped so generation itself stays well under `serde_json`'s
/// recursion limit while the fixed attack strings push past it from the other side.
fn arbitrary_json(unstructured: &mut Unstructured<'_>, depth: u8) -> Option<serde_json::Value> {
    if depth == 0 {
        return Some(serde_json::Value::String(
            unstructured.arbitrary::<String>().ok()?,
        ));
    }
    Some(match unstructured.int_in_range::<u8>(0..=5).ok()? {
        0 => serde_json::Value::Null,
        1 => serde_json::Value::Bool(bool::arbitrary(unstructured).ok()?),
        2 => {
            let attacked = ATTACK_NUMBERS
                .get(unstructured.choose_index(ATTACK_NUMBERS.len()).ok()?)
                .and_then(|number| serde_json::from_str::<serde_json::Value>(number).ok());
            match attacked {
                Some(value) => value,
                None => serde_json::Value::from(i64::arbitrary(unstructured).ok()?),
            }
        }
        3 => serde_json::Value::String(unstructured.arbitrary::<String>().ok()?),
        4 => {
            let len = unstructured.int_in_range(0..=6usize).ok()?;
            let mut items = Vec::new();
            for _ in 0..len {
                items.push(arbitrary_json(unstructured, depth - 1)?);
            }
            serde_json::Value::Array(items)
        }
        _ => {
            let len = unstructured.int_in_range(0..=6usize).ok()?;
            let mut map = serde_json::Map::new();
            for _ in 0..len {
                let key = unstructured.arbitrary::<String>().ok()?;
                let value = arbitrary_json(unstructured, depth - 1)?;
                map.insert(key, value);
            }
            serde_json::Value::Object(map)
        }
    })
}

/// One request shape: either raw arbitrary bytes reinterpreted as JSON, an envelope built
/// around a real or bogus method, or one of the fixed attack strings.
fn arbitrary_request(unstructured: &mut Unstructured<'_>) -> Option<String> {
    match unstructured.int_in_range::<u8>(0..=7).ok()? {
        // Raw byte soup: mostly invalid JSON, which must stay a decode error.
        0 => unstructured.arbitrary::<String>().ok(),
        // A real method with arbitrary parameters.
        1 => Some(format!(
            "{{\"method\":{},\"params\":{}}}",
            serde_json::to_string(real_method(unstructured)?).ok()?,
            serde_json::to_string(&arbitrary_json(unstructured, 3)?).ok()?,
        )),
        // A bogus method with arbitrary parameters.
        2 => Some(format!(
            "{{\"method\":{},\"params\":{}}}",
            serde_json::to_string(&unstructured.arbitrary::<String>().ok()?).ok()?,
            serde_json::to_string(&arbitrary_json(unstructured, 3)?).ok()?,
        )),
        // Params omitted — the decoder substitutes an empty object for the methods that take
        // none, and must reject the rest.
        3 => Some(format!(
            "{{\"method\":{}}}",
            serde_json::to_string(real_method(unstructured)?).ok()?,
        )),
        // Params explicitly null — same substitution, same rejection.
        4 => Some(format!(
            "{{\"method\":{},\"params\":null}}",
            serde_json::to_string(real_method(unstructured)?).ok()?,
        )),
        // Arbitrary JSON of any shape at the top level.
        5 => serde_json::to_string(&arbitrary_json(unstructured, 3)?).ok(),
        // Nesting past serde_json's recursion limit: an error, never a crash.
        6 => Some(format!(
            "{0}{1}{0}",
            "[".repeat(ATTACK_DEPTH),
            "1".repeat(ATTACK_DEPTH / 4),
        )),
        // A fixed attack string, or a character-level mutation of a valid request.
        _ => {
            if bool::arbitrary(unstructured).ok()? {
                ATTACK_JSON
                    .get(unstructured.choose_index(ATTACK_JSON.len()).ok()?)
                    .map(|request| (*request).to_string())
            } else {
                let seed =
                    *VALID_REQUESTS.get(unstructured.choose_index(VALID_REQUESTS.len()).ok()?)?;
                mutate_chars(unstructured, seed)
            }
        }
    }
}

#[test]
fn protocol_decoder_never_panics_on_pseudo_random_requests() {
    let seed = SEED_PROTOCOL;
    for iteration in 0..iterations() {
        run_round(
            "protocol decoder",
            seed,
            iteration,
            |input| {
                let _ = protocol::decode_request(input);
            },
            arbitrary_request,
        );
    }
}

/* ---------- Target 2: the Gerrit meta parser ---------- */

/// Headers real Gerrit `NoteDb` meta commits carry, plus empty and arbitrary-shaped ones.
const META_HEADERS: &[&str] = &[
    "Create change",
    "Update patch set 3",
    "Uploaded patch set 2.",
    "Uploaded patch set 2 (WIP)",
    "Patch Set 2: Code-Review+2",
    "Patch Set 1: Verified-1",
    "Abandoned",
    "Restored",
    "Restore",
    "Restore Ready for Review",
    "Remove WIP",
    "Ready for review change",
    "Rebase",
    "Patch Set 2: Rebase",
    "Change has been successfully merged",
    "Change has been successfully cherry-picked as 0123456789abcdef0123456789abcdef01234567 by Alice",
    "Create patch set 1",
    "Unabandon change",
    "",
];

/// A number string at the edges of the grammar's integer handling: `u32` overflow, `i32`
/// overflow for vote values, and ordinary values.
fn arbitrary_attack_number(unstructured: &mut Unstructured<'_>) -> Option<String> {
    Some(match unstructured.int_in_range::<u8>(0..=3).ok()? {
        0 => u32::MAX.to_string(),
        1 => (i32::MIN as i64).to_string(),
        2 => (i32::MAX as i64 + 1).to_string(),
        _ => unstructured.arbitrary::<u32>().ok()?.to_string(),
    })
}

fn arbitrary_choice<'a>(
    unstructured: &mut Unstructured<'_>,
    choices: &[&'a str],
) -> Option<&'a str> {
    choices
        .get(unstructured.choose_index(choices.len()).ok()?)
        .copied()
}

/// Footer lines real Gerrit meta commits carry, with their hostile variations.
fn arbitrary_footer(unstructured: &mut Unstructured<'_>) -> Option<String> {
    Some(match unstructured.int_in_range::<u8>(0..=7).ok()? {
        0 => format!("Patch-set: {}", arbitrary_attack_number(unstructured)?),
        1 => format!(
            "Status: {}",
            arbitrary_choice(
                unstructured,
                &["new", "merged", "abandoned", "NEW", "", "merged "]
            )?
        ),
        2 => format!(
            "Commit: {}",
            if bool::arbitrary(unstructured).ok()? {
                "0123456789abcdef".repeat(unstructured.int_in_range(0..=4usize).ok()?)
            } else {
                unstructured.arbitrary::<String>().ok()?
            }
        ),
        3 => format!(
            "Work-in-progress: {}",
            arbitrary_choice(unstructured, &["true", "false", "TRUE", "", "1"])?
        ),
        4 => format!(
            "Label: {}={}",
            unstructured.arbitrary::<String>().ok()?,
            arbitrary_attack_number(unstructured)?
        ),
        5 => format!(
            "Submitted-by: {}{}",
            unstructured.arbitrary::<String>().ok()?,
            if bool::arbitrary(unstructured).ok()? {
                " <a@b.c>"
            } else {
                ""
            }
        ),
        6 => format!(
            "{}: {}",
            unstructured.arbitrary::<String>().ok()?,
            unstructured.arbitrary::<String>().ok()?
        ),
        _ => unstructured.arbitrary::<String>().ok()?,
    })
}

/// A meta message in a shape real Gerrit writes (the same shapes the differential tests pin),
/// for mutation.
fn known_message(unstructured: &mut Unstructured<'_>) -> Option<&'static str> {
    arbitrary_choice(
        unstructured,
        &[
            "Create change\n\nUploaded patch set 1.\n\nPatch-set: 1\n",
            "Patch Set 2: Code-Review+2\n\nPatch-set: 2\nLabel: Code-Review=+2\n",
            "Uploaded patch set 3.\n\nChange has been successfully merged by Alice Developer <alice@example.com>\n\nPatch-set: 3\nStatus: merged\n",
            "Abandoned\n\nPatch-set: 2\n",
            "Restore Ready for Review\n\nPatch-set: 2\n",
            "Start Work In Progress\n\nPatch-set: 1\nWork-in-progress: true\n",
            "Update patch set 3\n\nPatch-set: 3\nCommit: 0123456789abcdef0123456789abcdef01234567\n",
            "Status: new\n",
            "\n\n\nPatch-set: 1\n",
        ],
    )
}

/// One synthesized meta message: an arbitrary header plus zero to six arbitrary footers,
/// joined with LF or CRLF, optionally with a body line between them.
fn arbitrary_meta_message(unstructured: &mut Unstructured<'_>) -> Option<String> {
    match unstructured.int_in_range::<u8>(0..=3).ok()? {
        // Raw arbitrary text.
        0 => unstructured.arbitrary::<String>().ok(),
        // A character-level mutation of a message real Gerrit writes.
        1 => {
            let seed = known_message(unstructured)?;
            mutate_chars(unstructured, seed)
        }
        // Synthesized header + body + footers.
        _ => {
            let newline = if bool::arbitrary(unstructured).ok()? {
                "\r\n"
            } else {
                "\n"
            };
            let mut lines = vec![
                arbitrary_choice(unstructured, META_HEADERS)?.to_string(),
                if bool::arbitrary(unstructured).ok()? {
                    unstructured.arbitrary::<String>().ok()?
                } else {
                    format!(
                        "Uploaded patch set {}.",
                        unstructured.arbitrary::<u32>().ok()?
                    )
                },
            ];
            for _ in 0..unstructured.int_in_range(0..=6usize).ok()? {
                lines.push(arbitrary_footer(unstructured)?);
            }
            Some(lines.join(newline))
        }
    }
}

/// Messages the grammar must survive: every input channel of the parser poked directly —
/// empty text, headers without footers, footers without headers, line separators, and
/// regex-backtracking bait in the header-vote and merged-by patterns.
const ATTACK_MESSAGES: &[&str] = &[
    "",
    "\n",
    "\r\n",
    "\r",
    "\n\n\n\n\n\n",
    "Patch-set: 1",
    "Patch Set 1: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+2",
    "Patch Set 1: ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++2",
    "Patch Set 1: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "Change has been successfully merged by +2\n\nPatch-set: 1",
    "Change has been successfully pushed as zzzz by <>\n\nPatch-set: 1",
    "Label: =+2\nLabel: =-2\nPatch-set: 1",
    "Label: \u{0}\u{0}\u{0}=+2\nPatch-set: 1",
    "Uploaded patch set 99999999999999999999999999.\n\nPatch-set: 99999999999999999999999999\n",
    "Patch-set: 0000000000000000000000000000000001\nPatch Set 00000000000000000042: A",
    "Submitted-by:\nSubmitted-by: <>\nPatch-set: 1",
    "Commit: G\nCommit: 0123456789abcdef0123456789abcdef0123456789abcdef\nPatch-set: 1",
    "Remove WIP\nWork-in-progress: maybe\nPatch-set: 1\nStatus: merged\nAbandoned",
    "Restore Ready for Review Rebase Unabandon Uploaded patch set 1\nPatch-set: 1",
];

#[test]
fn gerrit_meta_parser_never_panics_on_pseudo_random_messages() {
    let seed = SEED_GERRIT;
    for iteration in 0..iterations() {
        run_round(
            "Gerrit meta parser",
            seed,
            iteration,
            |input| {
                let _ = parse_gerrit_meta_message("Gerrit User 1000018", 1_600_000_000, input);
            },
            |unstructured| {
                if bool::arbitrary(unstructured).ok()? {
                    ATTACK_MESSAGES
                        .get(unstructured.choose_index(ATTACK_MESSAGES.len()).ok()?)
                        .map(|message| (*message).to_string())
                } else {
                    arbitrary_meta_message(unstructured)
                }
            },
        );
    }
}
