# CLAUDE.md — see `AGENTS.md`

The standing operating rules for this repository live in
[`AGENTS.md`](AGENTS.md). It is the canonical source: hard gates, owner
authorization gates, engineering discipline, the evidence standard,
repository isolation, architectural boundaries, security rules, the
verification gate, git and PR policy, stop conditions, and reporting.

This file deliberately holds no rules of its own. Everything it used to
contain was folded into `AGENTS.md`, so there is one place to read and one
place to change. Don't re-add rules here — they would drift out of sync
with the real ones.

## Finishing a ticket is not finished until the branch is gone

Pointer, not a rule — the rule is [`AGENTS.md` §25.1](AGENTS.md), steps 8
and 9, and that is the only place its text may live.

**Every time you finish: verify tree-identity, delete the branch, then
sweep for any OTHER branch whose PR has since merged and delete those
too.** Owner instruction, 2026-08-22, after a sweep found nine merged
branches still present — some for two weeks.

It is named here because this file is read at the start of every session
and §25.1 is read when someone goes looking. The decision procedure,
including the two tests that give WRONG answers (ancestry, and file
presence), is in §25.1 — go there before deleting anything.

Existing code comments, CDRs, review records, and log entries cite
"CLAUDE.md" by name for rules that now live in `AGENTS.md` — the ban on a
blanket 23505-means-duplicate, the canonical source priority, the
real-PostgreSQL race-test requirement, the owner gates. Those citations
are historical record and were left as written; read them as pointing at
the corresponding section of `AGENTS.md`.

For what is actually true right now, rather than process, read
`docs/agent/PROJECT-STATE.md`, `AUTONOMOUS-RUN-LOG.md`, and the backlog.
