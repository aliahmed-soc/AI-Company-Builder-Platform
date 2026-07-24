// ACBP-P1-014 / CDR-020 §4 — the SHARED declarative threat inventory for the tenant-isolation adversarial
// suite. Test-only (never imported by production code).
//
// Every adversarial test references a STABLE threat identifier from this table, and every failure title
// names the identifier + domain + the isolation invariant it protects — never a bare matrix index. The
// identifiers are the contract between the suite files and the README; adding a domain means reusing these
// ids, not inventing parallel wording.
//
// Canon: NFR-001; ADR-007 (two-layer isolation: app scoping + database RLS, immutable ownership);
// TEST-AND-VERIFICATION-STRATEGY trust-critical #1 (Tenant A cannot retrieve Tenant B's company), #2 (no
// enumeration of another tenant's artifacts) and #20 (a client-altered provider org/role value grants no
// elevated authority).

/** Attack classes (mirrors the discovery brief's matrix sections A–F). */
export const THREAT_CLASSES = ['scope', 'authz', 'rls', 'transaction', 'oracle', 'audit', 'admin'] as const;
export type ThreatClass = (typeof THREAT_CLASSES)[number];

export interface Threat {
  /** Stable identifier — quoted verbatim in test titles. Never renumbered. */
  readonly id: string;
  readonly class: ThreatClass;
  /** The attack, in one line. */
  readonly attack: string;
  /** The isolation invariant that must hold. */
  readonly invariant: string;
  /** Trust-critical mapping (TEST-AND-VERIFICATION-STRATEGY §"Trust-critical negative tests"). */
  readonly trustCritical: ReadonlyArray<1 | 2 | 20>;
}

export const THREATS = [
  // ── A. Scope establishment ────────────────────────────────────────────────────────────────────────
  { id: 'SCOPE-ACTOR-MISSING', class: 'scope', attack: 'operate with no app.current_actor', invariant: 'self-branch reads and actor-keyed policies reveal nothing', trustCritical: [1] },
  { id: 'SCOPE-ACTOR-FORGED', class: 'scope', attack: 'set app.current_actor to another user (or junk)', invariant: 'a forged actor never inherits another user’s membership or admin standing', trustCritical: [1, 20] },
  { id: 'SCOPE-ACCOUNT-MISSING', class: 'scope', attack: 'query account-scoped tables with no app.current_account', invariant: 'fail-closed: zero rows, zero affected rows, no cast error', trustCritical: [1] },
  { id: 'SCOPE-ACCOUNT-FORGED', class: 'scope', attack: 'set app.current_account to another tenant’s account', invariant: 'RLS confines every read/write to the actor’s own account', trustCritical: [1] },
  { id: 'SCOPE-COMPANY-MISSING', class: 'scope', attack: 'query company-detail tables with no app.current_company', invariant: 'dual-keyed policies fail closed without the company key', trustCritical: [1] },
  { id: 'SCOPE-COMPANY-FORGED', class: 'scope', attack: 'set app.current_company to a company of another account', invariant: 'both keys must agree; a forged company reveals and mutates nothing', trustCritical: [1] },
  { id: 'SCOPE-ACCOUNT-COMPANY-MISMATCH', class: 'scope', attack: 'pair a real account with a real company that belongs to a different account', invariant: 'the pair is verified in-database; mismatch yields nothing', trustCritical: [1] },
  { id: 'SCOPE-SELECTOR-HARVESTED', class: 'scope', attack: 'use ids harvested from another tenant as request selectors', invariant: 'ids are selectors only — never authority', trustCritical: [1, 2] },

  // ── B. Authorization confusion ────────────────────────────────────────────────────────────────────
  { id: 'AUTHZ-ACCOUNT-OWNER-NOT-COMPANY-MEMBER', class: 'authz', attack: 'account owner reaches a company they hold no company membership in', invariant: 'account ownership never auto-grants company access', trustCritical: [1] },
  { id: 'AUTHZ-VIEWER-MUTATION', class: 'authz', attack: 'a viewer performs an owner-only mutation', invariant: 'role checks come from fresh internal membership, deny-by-default', trustCritical: [20] },
  { id: 'AUTHZ-REVOKED-ACCOUNT', class: 'authz', attack: 'act after the account membership was revoked', invariant: 'revocation is effective on the very next resolution — no cached authority', trustCritical: [1] },
  { id: 'AUTHZ-REVOKED-COMPANY', class: 'authz', attack: 'act after the company membership was revoked', invariant: 'revocation is effective on the very next resolution', trustCritical: [1] },
  { id: 'AUTHZ-STALE-AFTER-RESOLUTION', class: 'authz', attack: 'revoke membership between resolution and the protected action / enrichment', invariant: 'no stale row is served; the next action re-resolves and denies', trustCritical: [1] },
  { id: 'AUTHZ-FORGED-CLERK-ROLE', class: 'authz', attack: 'supply forged provider org/role/admin claims from the client', invariant: 'browser-controlled claims never authorize; internal state is authoritative', trustCritical: [20] },
  { id: 'AUTHZ-PLATFORM-ADMIN-NOT-TENANT', class: 'admin', attack: 'a platform admin uses ordinary account/company APIs without membership', invariant: 'platform authority grants NO tenant authority', trustCritical: [1, 20] },
  { id: 'AUTHZ-TENANT-NOT-PLATFORM-ADMIN', class: 'admin', attack: 'a tenant owner/viewer invokes the admin surface', invariant: 'tenant roles never satisfy admin:tenant_read (empty allow-list + DB gate)', trustCritical: [20] },

  // ── C. Database / RLS bypass ──────────────────────────────────────────────────────────────────────
  { id: 'RLS-PREDICATE-REMOVED-READ', class: 'rls', attack: 'read with the application tenant predicate omitted entirely', invariant: 'RLS alone confines the result — an app-layer bug cannot cross tenants', trustCritical: [1, 2] },
  { id: 'RLS-PREDICATE-REMOVED-WRITE', class: 'rls', attack: 'UPDATE/DELETE with the application tenant predicate omitted', invariant: 'RLS alone confines the affected rows (or the grant is absent)', trustCritical: [1] },
  { id: 'RLS-FORGED-DUAL-KEY-INSERT', class: 'rls', attack: 'INSERT a row stamped with a foreign account/company', invariant: 'WITH CHECK binds every written key to the active scope', trustCritical: [1] },
  { id: 'RLS-TENANT-REASSIGNMENT', class: 'rls', attack: 'move an owned row to another account/company via UPDATE', invariant: 'ownership columns are immutable; WITH CHECK re-asserts', trustCritical: [1] },
  { id: 'RLS-ON-CONFLICT-CROSS-TENANT', class: 'rls', attack: 'use ON CONFLICT to touch or probe a foreign tenant’s row', invariant: 'conflict handling never reads, mutates or confirms a foreign row', trustCritical: [1, 2] },
  { id: 'RLS-COLUMN-PRIVILEGE', class: 'rls', attack: 'update identity/scope columns through a column-limited grant', invariant: 'column-level grants confine mutation to outcome columns', trustCritical: [1] },
  { id: 'RLS-JOIN-CTE-SUBQUERY', class: 'rls', attack: 'reach foreign rows through a join, CTE or subquery', invariant: 'policies apply to every relation reference, not just the outer query', trustCritical: [1, 2] },
  { id: 'RLS-CATALOG-TAMPER', class: 'rls', attack: 'ALTER/DROP policies, DISABLE or UN-FORCE RLS, SET ROLE, self-GRANT', invariant: 'the restricted role cannot alter its own confinement', trustCritical: [1] },

  // ── D. Transactions, pooling, GUC lifecycle ───────────────────────────────────────────────────────
  { id: 'TX-GUC-COMMIT-CLEANUP', class: 'transaction', attack: 'reuse a pooled connection after a committed scoped transaction', invariant: 'SET LOCAL context dies at COMMIT', trustCritical: [1] },
  { id: 'TX-GUC-ROLLBACK-CLEANUP', class: 'transaction', attack: 'reuse a pooled connection after a rolled-back scoped transaction', invariant: 'context dies at ROLLBACK', trustCritical: [1] },
  { id: 'TX-GUC-THROWN-ERROR-CLEANUP', class: 'transaction', attack: 'reuse a pooled connection after an application error inside the scope', invariant: 'a thrown error leaves no residual context', trustCritical: [1] },
  { id: 'TX-GUC-DENIAL-CLEANUP', class: 'transaction', attack: 'reuse a pooled connection after an authorization denial', invariant: 'a denied operation leaves no residual context', trustCritical: [1] },
  { id: 'TX-SCOPE-MUTATION', class: 'transaction', attack: 'change the account/company GUC partway through a scoped transaction', invariant: 'no cross-tenant visibility is obtained mid-transaction', trustCritical: [1] },
  { id: 'TX-NESTED-SCOPE', class: 'transaction', attack: 'open a nested tenant scope inside an active one', invariant: 'nesting is rejected by the accepted scope API (nestedTransactionError)', trustCritical: [1] },
  { id: 'TX-CONCURRENT-ACCOUNTS', class: 'transaction', attack: 'run account A and account B operations concurrently on one pool', invariant: 'each transaction sees only its own account', trustCritical: [1] },
  { id: 'TX-CONCURRENT-COMPANIES', class: 'transaction', attack: 'run A1/A2/B1/B2 company operations concurrently', invariant: 'each transaction sees only its own company', trustCritical: [1] },

  // ── E. Enumeration / existence oracles ────────────────────────────────────────────────────────────
  { id: 'ORACLE-FOREIGN-ID', class: 'oracle', attack: 'address a REAL foreign id through a product path', invariant: 'the denial is indistinguishable from any other denial', trustCritical: [1, 2] },
  { id: 'ORACLE-UNKNOWN-ID', class: 'oracle', attack: 'address a well-formed id that exists nowhere', invariant: 'identical response to the foreign-id case — no existence bit', trustCritical: [2] },
  { id: 'ORACLE-MALFORMED-ID', class: 'oracle', attack: 'address a malformed/SQL-shaped/control-character id', invariant: 'same coarse denial; never a cast error, SQLSTATE or constraint name', trustCritical: [2] },
  { id: 'ORACLE-COUNT-PROBE', class: 'oracle', attack: 'probe with COUNT(*)/EXISTS/join/subquery as the restricted role', invariant: 'aggregates observe only in-scope rows — no foreign totals', trustCritical: [2] },
  { id: 'ORACLE-ERROR-DETAIL', class: 'oracle', attack: 'trigger a database error and read the response body', invariant: 'errors are bounded envelopes — no SQL, constraint, table or id detail', trustCritical: [2] },
  { id: 'CURSOR-CROSS-COMPANY', class: 'oracle', attack: 'replay a keyset cursor minted for another company (caller is a member of both)', invariant: 'cursors are bound to their documented account/actor/company context', trustCritical: [1, 2] },
  { id: 'CURSOR-CROSS-ACCOUNT', class: 'oracle', attack: 'replay a portfolio cursor minted under another account/actor', invariant: 'the cursor is rejected, not silently re-scoped', trustCritical: [1, 2] },
  { id: 'LOG-DENIAL-PRIVACY', class: 'oracle', attack: 'read structured denial logs after a cross-tenant attempt', invariant: 'no foreign name/profile/member content, token, SQL or existence bit is logged', trustCritical: [2] },

  // ── F. Audit / activity integrity ─────────────────────────────────────────────────────────────────
  { id: 'AUDIT-CROSS-TENANT-FORGERY', class: 'audit', attack: 'write an audit row stamped for another account/company/actor', invariant: 'server-bound scope fields cannot be forged; WITH CHECK denies', trustCritical: [1] },
  { id: 'AUDIT-APPEND-ONLY', class: 'audit', attack: 'UPDATE/DELETE/TRUNCATE audit or activity rows', invariant: 'append-only grants hold for the restricted role (invariant 11)', trustCritical: [1] },
  { id: 'AUDIT-ROLLBACK-ATOMICITY', class: 'audit', attack: 'make the audit write fail during an audited mutation', invariant: 'the whole business transaction rolls back — no silent unaudited effect', trustCritical: [1] },
  { id: 'ACTIVITY-SOURCE-SWAP', class: 'audit', attack: 'project an activity row keyed to a foreign/substituted source audit event', invariant: 'projection is keyed to its own in-scope source event only', trustCritical: [1] },
  { id: 'ACTIVITY-TAXONOMY-CLOSED', class: 'audit', attack: 'introduce a non-lifecycle activity type (provisioning/admin)', invariant: 'the feed taxonomy stays the four company lifecycle events', trustCritical: [1] },
] as const satisfies ReadonlyArray<Threat>;

export type ThreatId = (typeof THREATS)[number]['id'];

const BY_ID = new Map<string, Threat>(THREATS.map((t) => [t.id, t]));

/** Look up a threat, throwing on an unknown id so a typo can never silently produce an unmapped test. */
export function threat(id: ThreatId): Threat {
  const t = BY_ID.get(id);
  if (t === undefined) throw new Error(`unknown threat id: ${id}`);
  return t;
}

/**
 * The canonical test title for an adversarial case: threat id + domain + the isolation invariant.
 * Example: `[SCOPE-COMPANY-FORGED] companies — both keys must agree; a forged company reveals ... `
 */
export function threatTitle(id: ThreatId, domain: string): string {
  const t = threat(id);
  return `[${t.id}] ${domain} — ${t.invariant}`;
}
