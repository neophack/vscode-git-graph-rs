# Architecture Decision Records

Decisions here are the ones a contributor would otherwise have to reverse-engineer from git
archaeology: which way a trade-off was taken and why. The living description of the tree is
[`../ARCHITECTURE.md`](../ARCHITECTURE.md). An ADR is the record that a decision *changed*
something, kept when the change's reasoning would not be obvious from the code alone.

## Format

One file per decision, named `adr-NNNN-short-title.md` (`NNNN` sequential from `0001`):

```markdown
# ADR NNNN: short title

Date: YYYY-MM-DD
Status: Accepted | Superseded by adr-MMMM

## Context

The forces at play: the constraint or problem that forced a choice.

## Decision

What was chosen, in a sentence or two. Written in the present tense ("the host bundles to a
single file"), because the file documents the state, not the meeting.

## Consequences

What this makes easier, what it costs, and what it rules out. If a later ADR reverses this
one, link it from the Status line of both.
```

Rules of thumb:

- **Decisions, not tasks.** "Introduce Vitest" is a decision (test strategy changed);
  "split file X" is not.
- **Short.** A screen, not a document; deep reasoning belongs in the ADR that argued for it,
  or in [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — link it.
- **Index the commits.** List the commit(s) that embody the decision, so `git show` from the
  ADR lands the reader on the code that enacted it.
- Update an ADR by superseding it with a new one, not by editing history out of an accepted one.
