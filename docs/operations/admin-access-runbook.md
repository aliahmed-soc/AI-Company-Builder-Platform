# Platform-admin access — operational runbook (stub)

Status: **runbook stub** (ACBP-P1-013; CDR-019). Governs the ONLY way a platform administrator is granted or
revoked: an explicit, human-executed operation on the **owner/migration connection** (`DATABASE_URL`) — the
canonical "migrations + explicit admin setup ONLY" use of that role (TENANCY.md). **No runtime API, no
application wrapper, no environment variable, and no default row can create or change an admin.** The
restricted runtime role can only self-check a single row and cannot enumerate or mutate the allowlist.

## Preconditions for EVERY grant or revocation

1. The target's **internal user id** (`users.id` — never a Clerk id, email, or name).
2. A **change/ticket reference** (issue id or change record).
3. A **stated operational reason** (recorded in the change record; this runbook stores no secrets and no
   credentials — never paste connection strings, passwords, or tokens into tickets, docs, or logs).
4. Owner-connection access per the established secret-management process (ADR-021). Do not copy the
   connection string anywhere.

## Grant

Run in an **explicit transaction** on the owner connection:

```sql
begin;
insert into public.platform_admins (user_id) values ('<internal-user-uuid>');
commit;
```

**Post-change verification (required):**

```sql
select user_id, status, created_at, revoked_at from public.platform_admins where user_id = '<internal-user-uuid>';
-- expect exactly one row: status = 'active', revoked_at IS NULL
```

Record the verification output row (ids and timestamps only) in the change record.

## Revocation (also the rollback procedure for a grant)

```sql
begin;
update public.platform_admins set status = 'revoked', revoked_at = now() where user_id = '<internal-user-uuid>';
commit;
```

**Post-change verification (required):** re-run the SELECT above; expect `status = 'revoked'` with a
non-null `revoked_at`. Revocation takes effect on the administrator's NEXT request (admin standing is checked
freshly on every request — nothing is cached).

Un-doing an accidental revocation is a new grant-shaped change (`status='active', revoked_at=null` via UPDATE)
with its own ticket reference and verification; never edit history.

## Never

- Grant via any application endpoint (none exists — by design; do not build one).
- Use the owner connection from application runtime code.
- Record credentials, connection strings, or session tokens in tickets, docs, or logs.
- Leave a grant unverified or unticketed.

Break-glass access is a SEPARATE, not-yet-implemented path — see
`docs/architecture/BREAK-GLASS-DESIGN.md` (design only; ACBP-P1-013 ships no break-glass mechanism).
