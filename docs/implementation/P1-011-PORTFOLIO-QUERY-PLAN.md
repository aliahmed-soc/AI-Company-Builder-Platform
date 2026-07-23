# P1-011 — Portfolio query-plan evidence & index decision (CDR-017 §10)

CDR-017 §10 permits an ADDITIVE, index-only migration **only if realistic PostgreSQL EXPLAIN evidence proves
the existing indexes inadequate**. This note records the access-path analysis and the resulting decision.

## The query (Slice 2)

`PortfolioRepository.listActiveMembershipCompanies` runs under an **AccountScope** (`app.current_account` +
`app.current_actor` set; `app.current_company` unset):

```
select c.id, c.status, cm.role, (extract(epoch from c.created_at)*1000000)::bigint::text
from company_memberships cm
join companies c on c.id = cm.company_id and c.account_id = cm.account_id
where cm.member_user_id = :actor and cm.status = 'active'
  and ( c.created_at < :afterTs or (c.created_at = :afterTs and c.id < :afterId) )   -- keyset page ≥ 2 only
order by c.created_at desc, c.id desc
limit :n
```

RLS adds, transparently: the `company_memberships` SELECT **self-branch** (`member_user_id =
app.current_actor` — the company GUC is unset, so ONLY the self-branch qualifies) and the account-scoped
`companies` SELECT (`account_id = app.current_account`).

## Access path

- **Driving relation: `company_memberships`, filtered by `member_user_id = :actor AND status = 'active'`.**
  Migration 0008 ships a partial index precisely for this: `company_memberships_member_idx on
  (member_user_id) where status = 'active'`. Both the SQL predicate and the RLS self-branch collapse onto that
  index. The driving set is therefore the actor's **active** company memberships — a small, bounded fan-out
  (a user belongs to a handful, not millions, of companies), never a scan of the account's whole company
  registry.
- **Join to `companies`: primary-key lookup** on `companies.id` (the `company_id` FK of each membership row),
  one PK probe per driving row. The extra `account_id` equality is a residual on the already-fetched row.
- **ORDER BY / keyset predicate on `companies.created_at, companies.id`:** applied to the bounded joined set
  (size = the actor's active-membership count). A sort of that many rows is negligible; the keyset predicate
  is a residual filter on the same bounded set.

## Hosted real-PostgreSQL EXPLAIN evidence (Slice 6)

`packages/database/src/integration/portfolio-plan.integration.test.ts` seeds a REALISTIC, ANALYZEd population
(10 accounts; ~2,800 companies; ~2,300 memberships including revoked rows, a 500-membership same-account noise
actor, cross-account noise, and an exact-microsecond `created_at` tie) and runs `EXPLAIN (FORMAT JSON)` on the
exact query shape as the restricted `acbp_app` role under the account+actor GUCs — so the RLS policy predicates
are part of the planned query. **No planner settings are forced**; the natural plan is asserted semantically
(index names / node types, tolerant of normal variation) and recorded. The natural plan on hosted CI
(`postgres:16`, run `30004638933`, commit `650c424`) — IDENTICAL for the first page and the keyset page:

```
Limit
└─ Sort  (created_at DESC, id DESC)
   └─ Nested Loop
      ├─ Bitmap Heap Scan on company_memberships
      │  └─ Bitmap Index Scan using company_memberships_member_idx   ← the partial active-membership index
      └─ Index Scan on companies using companies_pkey                ← indexed join key, one probe per row
```

Confirmed properties (asserted by the suite): access begins from the actor's active memberships via
`company_memberships_member_idx`; the `companies` join is a `companies_pkey` index probe; **no sequential scan
of either relation** (no unbounded account-wide scan); only `company_memberships` + `companies` are touched
(no profile query); a `Limit` bounds the read, the compiled SQL contains **no OFFSET**, and a `Sort` on
`(created_at, id)` makes ordering deterministic; the `app.current_account` / `app.current_actor` predicates
survive into the planned quals. The same suite walks the REAL `PortfolioRepository` over the same population
(12 rows; strict `(created_at_us, id)` descending order; the 3-way exact-microsecond tie broken by `id DESC`;
a pages-of-5 keyset walk with no overlap/gap) to bind the mirrored EXPLAIN shape to the production query.

**Why the Sort node is acceptable (not a deficiency):** the sort input is NOT the account's company registry —
it is the already-membership-filtered join output, whose cardinality is bounded by ONE actor's active company
memberships (tens, not thousands; structurally capped by what a human can hold memberships in). PostgreSQL runs
it as a top-N sort under the `Limit` (≤ 101 rows retained). An ordering index on
`companies(account_id, created_at DESC, id DESC)` could only replace this sort by driving the scan from the
account's WHOLE registry and filtering memberships per row — precisely the account-wide access pattern CDR-017
§2 forbids the product query from having, and strictly more I/O at every realistic scale. A bounded sort of a
bounded set is the correct shape here.

## Decision — NO index migration

The hosted EXPLAIN evidence confirms the analysis above: the natural plan is membership-index-driven
(`company_memberships_member_idx` answers the actor+active predicate), the join is a `companies_pkey` probe per
candidate, and the sort is bounded top-N — nothing scans an unbounded relation, and no plan deficiency exists
for a new index to fix. Per CDR-017 §10, **no index-only migration is added** — migrations remain 0001–0009,
and CDR-017 §11 (no fourth SECURITY DEFINER; no RLS/persistence migration) is preserved. The evidence suite
EXPLAINs the exact production builder (`PortfolioRepository.buildListQuery`), so this evidence is re-validated
on every CI run and cannot drift from the shipped query.

The candidate indexes CDR-017 §10 named for the *hypothetical* need (`company_memberships(account_id,
member_user_id, status, company_id)`; `companies(account_id, created_at DESC, id DESC)`) are **deliberately
NOT created**: the first is redundant with `company_memberships_member_idx` for this access path, and the
second would only matter if the portfolio scanned `companies` as the driving relation — which, by design, it
never does (it starts from memberships). If a future workload proves otherwise, that evidence — a real EXPLAIN
at representative volume — would be the trigger, added as its own additive migration.

The Slice 2 real-PostgreSQL integration test
(`packages/database/src/integration/portfolio.integration.test.ts`) proves the query's **correctness and
isolation** (membership-only visibility, self-branch gating, keyset order + tie-break, exact-microsecond
preservation) at small scale; it deliberately asserts no plan shape there (tiny fixtures legitimately
seq-scan). Plan-shape evidence lives exclusively in the Slice 6 suite above, where the ANALYZEd realistic
population makes the natural plan meaningful.
