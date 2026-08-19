# TICKET — the held-work review surface (ADMIN-002's confirm-or-discard, made drivable)

**Status:** filed, NOT started. **Origin:** owner ruling 2026-08-19, ruling 3, during ACBP-API-011.
**Blocks:** ACBP-FE-017's held-work section, and lifting any stop through the API.
**Pattern:** ACBP-API-003 — consequences attached, no scaffolding toward it, the blocked surface stays honestly
blocked rather than half-built.

---

## 1. The defect in one paragraph

`reviewHeldWork` is exported from `@acbp/core`, covered by real-PostgreSQL tests, and takes a `heldWorkId`.
**Nothing exported can produce one.** `readStopState` returns active stops, scope availability and the queue caveat
— no items. `clearStop` returns a `pendingReviewCount` and not the ids it counted.
`StopRepository.listHeld(stopId)` is the only thing that lists them, and it is called from exactly one place:
privately, inside `clearStop`, to compute that count.

So ADMIN-002's mandatory confirm-or-discard review is reachable in principle and **un-drivable in practice**. An
operator can be told six items await their decision and has no way to name one.

This is the shape `packages/core/src/stops/index.ts` already warns about in its own header — *"Being exported is not
being reachable"* — occurring one layer further out than the warning looks.

## 2. Why ACBP-API-011 did not fix it

The first draft added a `listHeldWork` read to core (reusing `stop:read` and the existing repository method) and
routed it. **The owner refused it at the gate:** adding a read core does not have is a DOMAIN ADDITION, not the
exposure ACBP-API-011 was scoped to, and the two must not ride in together.

The draft was reverted in full rather than left partly in place. No `listHeldWork`, no `clearStop` binding, no
unreachable union arm, no commented-out route. A half-built door is precisely how "exported is not reachable" got
its second life on this module, and a third would be self-inflicted.

## 3. The consequences, carried openly

1. **A stop raised through the API cannot be lifted through the API.** `POST /api/companies/{id}/stops` exists;
   there is no clear route. Lifting requires a direct core call.
2. **`clearStop` was NOT routed on its own**, deliberately. Clearing *opens* the mandatory review — so a lift button
   with no review surface behind it would let an operator end a halt while silently skipping the step canon
   requires. That is worse than no button.
3. **Four refusal reasons have no producer.** `not_found`, `not_active`, `already_reviewed` and `stop_still_active`
   are raised only by `clearStop` and `reviewHeldWork`. Their HTTP mappings exist, are correct, and are unreachable
   — disclosed in `companies-http.ts` and CDR-094 §3.3 so nobody reads them as a working clear path.
4. **ACBP-FE-017's held-work section stays blocked** on this ticket, and must say so on screen rather than render an
   empty queue. An empty queue and an unreachable queue look identical and mean opposite things — the "refused ≠
   empty" rule.

## 4. What the ticket has to do

1. A core read that lists held work for a stop, under the existing `stop:read` action. No new authz action, no new
   table, no new event — if any of those turn out to be needed, that is a further owner gate, not a detail.
2. Decide what the read returns. `listHeld` filters `status = 'held'`, so it is a work QUEUE and not a history;
   whether a reviewed-items view is also wanted is a product question, not an implementation one.
3. Route the read, `clearStop` and `reviewHeldWork` **together**, so the loop closes in one move.
4. Carry `heldQueueCaveat` onto the queue surface. The queue records what a stop INTERRUPTED, never everything it
   covers, and the count is a FLOOR — an operator who believes they have reviewed everything is CDR-072 §0's failure
   in its most direct form.
5. The full safety-critical bar, as ACBP-API-011 was held to: TDD, mutation-tested authorization applied-verified
   against real PostgreSQL, CSRF as state-changing, adversarial matrix rows, seeded invisibility proof (CDR-093).

## 5. Open questions for the owner, not for the implementer

- **Does clearing without a completed review stay possible at all?** Core permits it today; ADMIN-002 can be read as
  requiring the review before work resumes rather than before the stop lifts. Both readings are defensible and the
  choice is not the implementer's.
- **The account-wide gap (CDR-072 §1-G6, still open).** An `account_wide` stop writes held rows for the raising
  company only, so sibling companies' work resumes on clear **without** a confirm-or-discard decision. Any queue
  surface will display a number that is account-wide in name and single-company in fact. Fixing it means
  establishing each company's scope inside one account-wide operation — a tenant-isolation decision and an owner
  gate in its own right.
