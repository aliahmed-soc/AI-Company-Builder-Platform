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

## Decision — NO index migration

The existing indexes are adequate for the realistic shape of this query: a membership-driven lookup whose
cardinality is bounded by one actor's active memberships, with a PK join and a trivially small sort. Nothing
in the plan scans an unbounded relation. Per CDR-017 §10, absent EXPLAIN evidence of inadequacy **no
index-only migration is added** — migrations remain 0001–0009, and CDR-017 §11 (no fourth SECURITY DEFINER;
no RLS/persistence migration) is preserved.

The candidate indexes CDR-017 §10 named for the *hypothetical* need (`company_memberships(account_id,
member_user_id, status, company_id)`; `companies(account_id, created_at DESC, id DESC)`) are **deliberately
NOT created**: the first is redundant with `company_memberships_member_idx` for this access path, and the
second would only matter if the portfolio scanned `companies` as the driving relation — which, by design, it
never does (it starts from memberships). If a future workload proves otherwise, that evidence — a real EXPLAIN
at representative volume — would be the trigger, added as its own additive migration.

The Slice 2 real-PostgreSQL integration test
(`packages/database/src/integration/portfolio.integration.test.ts`) proves the query's **correctness and
isolation** (membership-only visibility, self-branch gating, keyset order + tie-break, exact-microsecond
preservation) on hosted CI. It intentionally does not assert a specific plan node: at the tiny row counts of
a test fixture PostgreSQL legitimately prefers sequential scans regardless of indexing, so a plan-shape
assertion there would be misleading rather than evidentiary.
