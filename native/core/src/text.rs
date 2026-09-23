//! Commit text as `git log` prints it.
//!
//! gix hands out a commit's author, committer and message as the raw bytes of the object. `git log`
//! does two things to them before printing that the engine has to repeat, or the two backends show
//! different text for the same commit:
//!
//! - **Re-encoding.** A commit made with `i18n.commitEncoding` set records an `encoding` header and
//!   stores its text in that encoding; `git log` converts it to UTF-8 (`i18n.logOutputEncoding`'s
//!   default). Decoding the raw bytes as UTF-8 instead turns `café` in ISO-8859-1 into `caf�`.
//! - **The subject.** `%s` skips the blank lines a message may start with and joins the first
//!   paragraph's lines with spaces, each trimmed of trailing whitespace. gix's `summary()` does not
//!   skip leading blank lines, so such a message has an empty subject there.

use gix::bstr::ByteSlice;

/// The encoding a commit's text is stored in, or `None` for UTF-8 (the default, and the only
/// encoding that needs no conversion).
pub struct CommitEncoding(Option<&'static encoding_rs::Encoding>);

impl CommitEncoding {
    /// Read the commit's `encoding` header. A label git knows but this decoder does not is treated
    /// as UTF-8, which is what the text most likely is anyway.
    pub fn of(commit: &gix::Commit<'_>) -> CommitEncoding {
        let label = commit
            .decode()
            .ok()
            .and_then(|decoded| decoded.encoding.map(|label| label.to_owned()));
        CommitEncoding(
            label
                .and_then(|label| encoding_rs::Encoding::for_label(label.trim()))
                .filter(|encoding| *encoding != encoding_rs::UTF_8),
        )
    }

    /// Decode text of this commit (an identity or its message) to a string.
    pub fn decode(&self, bytes: &[u8]) -> String {
        match self.0 {
            Some(encoding) => encoding.decode_without_bom_handling(bytes).0.into_owned(),
            None => String::from_utf8_lossy(bytes).into_owned(),
        }
    }
}

/// A commit's subject as `git log --format=%s` prints it: the first paragraph after any leading
/// blank lines, its lines trimmed of trailing whitespace and joined with single spaces.
pub fn subject(message: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut started = false;
    for line in message.lines() {
        let line = line.trim_end_with(|c| c.is_ascii_whitespace());
        if line.is_empty() {
            if started {
                break;
            }
            continue;
        }
        if started {
            out.push(b' ');
        }
        out.extend_from_slice(line);
        started = true;
    }
    out
}

/// A commit's subject, decoded — the one call most readers need.
pub fn commit_subject(commit: &gix::Commit<'_>, encoding: &CommitEncoding) -> String {
    let message = commit.message_raw_sloppy();
    encoding.decode(&subject(message))
}

#[cfg(test)]
mod tests {
    use super::subject;

    #[test]
    fn subject_skips_leading_blank_lines_and_folds_the_first_paragraph() {
        assert_eq!(
            subject(b"\n\n  leading blanks  \n\nbody"),
            b"  leading blanks"
        );
        assert_eq!(
            subject(b"first line\nsecond line\n\nbody"),
            b"first line second line"
        );
        assert_eq!(subject(b"crlf subject\r\n\r\nbody\r\n"), b"crlf subject");
        assert_eq!(subject(b"tabs\tand   spaces   \n"), b"tabs\tand   spaces");
        assert_eq!(subject(b""), b"");
    }
}
