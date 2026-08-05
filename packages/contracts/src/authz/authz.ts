// @acbp/contracts — provider-neutral authorization decision contract (ACBP-P1-007; ADR-022; ADR-006;
// SECURITY-ARCHITECTURE §1).
//
// The transport- and provider-neutral currency for the INTERNAL ROLE-CHECK step of the mandatory ADR-022
// authorization flow (`… → internal role check → tenant-scoped DB authorization → …`). This module is a
// PURE decision over an ALREADY-RESOLVED internal role:
//   - it performs NO IO and consults NO Clerk org/role claim, header, cookie, or UI state;
//   - it is NOT tenant isolation — which account/company a caller may touch is decided by AccountContext
//     (ACBP-P1-005) and enforced by row-level security (ACBP-P1-006); this only answers "may THIS role
//     perform THIS action?" once the account is already resolved;
//   - it mints no scope and selects no database connection.
// Deny-by-default at every branch. Zero-dependency, like the rest of @acbp/contracts.
import { platformError, ErrorCodes, type PublicErrorEnvelope } from '../errors.js';

/**
 * MVP internal membership roles (PRD §13; mirrors `MemberRole` in @acbp/core `members/roles.ts`). The union
 * is duplicated here — not imported — because @acbp/contracts is zero-dependency and sits BELOW @acbp/core
 * in the dependency graph. The two unions are intentionally identical so a core `MemberRole` is assignable
 * where an `AuthzRole` is expected without any mapping.
 */
export type AuthzRole = 'owner' | 'viewer';

/**
 * The CLOSED set of role-gated protected actions (the ADR-022 flow runs the role check on each). Naming is
 * `resource:verb`; the resource is implicit in the action name. Anything NOT listed here is an unknown
 * action and is DENIED — adding an action is a deliberate, reviewed change to the policy surface.
 *
 * Excluded by design (NOT role-gated actions): invite acceptance and personal-account provisioning are
 * pre-context self-service/bootstrap operations (no active-membership role exists yet), and the Clerk
 * webhook is signature-authenticated only — none pass through this role check.
 */
export const AUTHZ_ACTIONS = [
  'member:invite',
  'member:revoke',
  'member:list',
  'member:read_invited_email',
  'profile:read',
  'profile:update',
  // Company lifecycle (ACBP-P1-010; CDR-015). `company:create` is checked against the caller's ACCOUNT-membership
  // role (an account owner creates a company); the rest are checked against the caller's COMPANY-membership role
  // (resolved from company_memberships). Both use the same owner|viewer enum, so the single matrix suffices.
  'company:create',
  'company:read',
  'company:rename',
  'company:pause',
  'company:resume',
  'company:status',
  // Company activity feed (ACBP-P1-009; CDR-016). Checked against the caller's COMPANY-membership role.
  'activity:read',
  // Company portfolio (ACBP-P1-011; CDR-017 §7). An ACCOUNT-level action: checked against the caller's active
  // ACCOUNT-membership role (owner|viewer). It gates only the API CALL; result rows stay filtered by active
  // COMPANY membership (an account role never grants a portfolio row by itself). There is deliberately NO
  // `company:switch` action — switching is stateless URL-only re-resolution, not a role-gated operation.
  'portfolio:read',
  // Workspace provisioning (ACBP-P1-012; CDR-018 §11). Checked against the caller's COMPANY-membership role:
  // any active company member may READ provisioning status; only a company OWNER may RESUME. There is
  // deliberately NO start/retry/acknowledge/cancel action — resume is the single mutation surface.
  'provisioning:read',
  'provisioning:resume',
  // Platform-administrative access (ACBP-P1-013; CDR-019). Registered so the action is a named, closed member
  // of the policy surface — but granted to NO membership role (empty allow-list below): tenant owner/viewer
  // NEVER authorize it. Admin authority is a SEPARATE database-backed gate (the owner-managed platform_admins
  // self-check in @acbp/core's admin module), not a branch of this matrix.
  'admin:tenant_read',
  // Interview sessions (ACBP-P2-001; CDR-022 §6). Checked against the caller's COMPANY-membership role: any
  // active company member may READ the session, and any active company member may PARTICIPATE (start / suspend
  // / resume). There is deliberately NO `interview:confirm` action yet — the owner-only ready_for_review→
  // confirmed transition's operation belongs to P2-009, which registers that action when it implements the
  // confirmation effect (the P1-010→P1-013 per-ticket action convention).
  'interview:read',
  'interview:participate',
  // Typed memory (ACBP-P2-006; CDR-024 §3). Checked against the caller's COMPANY-membership role: any active
  // company member may READ the memory items and WRITE (create) a typed item. There is deliberately NO
  // `memory:edit`/`memory:delete` action yet — the owner-only edit/delete/supersede operations belong to the
  // memory browser (P2-010), which registers those actions when it implements them.
  'memory:read',
  'memory:write',
  // Memory browser (ACBP-P2-010; CDR-025). `memory:edit` is the OWNER-ONLY correction (versioned supersede) and
  // `memory:delete` is the OWNER-ONLY soft delete — API-CONTRACTS "Owner (edit/delete)", both DISTINCT from the
  // owner|viewer create/read grant and from each other in the closed registry (no overloading — the owner's
  // ratified CDR-025 §0 decision).
  'memory:edit',
  'memory:delete',
  // Understanding generation (ACBP-P2-008; CDR-029). Any active company member may GENERATE an understanding
  // document version and READ it — part of the discovery flow (like interview:participate + memory:write). The
  // owner-only CONFIRM / per-item review is P2-009, which registers its own action when it implements that effect.
  'understanding:generate',
  'understanding:read',
  // Understanding review + confirmation (ACBP-P2-009; CDR-030 §2/§3). Both OWNER-ONLY: `understanding:review` is the
  // five per-item controls (approve/edit/reject/request-evidence/request-research) AND the correction that supersedes
  // a confirmation; `understanding:confirm` is the owner-only overall confirm that unlocks strategy (API-CONTRACTS
  // "Owner (confirm)", UNDER-003 "Owner-only confirm"). DISTINCT from the owner+viewer `understanding:read`/`:generate`
  // grant — a corrective, owner-authority operation is not folded into the read/participate grant (no overloading, the
  // closed-registry convention P2-010 established for memory:edit/delete).
  'understanding:review',
  'understanding:confirm',
  // Task model (ACBP-P4-002; CDR-033 §4). Any active company member may CREATE/plan a task (proposed work on the board)
  // and READ tasks — like interview:participate/memory:write. The RUN trigger (planned→queued) is the owner/operator
  // gate owned by a later ticket (TASK-004/P6), NOT part of this create grant. `task:depend` folds into `task:create`.
  'task:create',
  'task:read',
  // Task deletion (ACBP-P4-005; CDR-043 §4-G1; TASK-008). Its own action rather than folded into `task:create`,
  // because it is the only task control that removes work from view — a named action makes a future owner-only
  // tightening a one-line policy change instead of a refactor. REPEAT is deliberately NOT here: it mints a task,
  // which is exactly what `task:create` already authorizes (the `task:depend` folding precedent).
  'task:delete',
  // Strategy option generation (ACBP-P3-001; CDR-034 §4; STRAT-001/002). `strategy:generate` covers generation +
  // request-another; `strategy:read` lists the options. Both owner|viewer (any active member drives the flow, like
  // understanding:generate). The owner-only SELECTION gate is STRAT-003/P3-004's separate action.
  'strategy:generate',
  'strategy:read',
  // Optional AI recommendation (ACBP-P3-003; CDR-036; STRAT-004). Advisory only — never auto-selects; the owner-only
  // SELECTION gate is STRAT-003/P3-004's separate action. Owner|viewer, consistent with the generate-class grants.
  'strategy:recommend',
  // Owner strategy decision (ACBP-P3-004; CDR-037; STRAT-003/005) — the OWNER-ONLY select/edit/combine/reject +
  // phase-limited-approval gate (the understanding:confirm owner-only precedent). request-another reuses strategy:generate.
  'strategy:select',
  // Immutable decision record (ACBP-P3-005; CDR-038; STRAT-006) — the OWNER-ONLY write of the durable, audit-grade
  // record of a decision (J-08 "Actor: owner"). Reads reuse strategy:read (the decision is surfaced on the strategy
  // read); a dedicated Decisions list/get surface is deferred with the strategy HTTP surface.
  'decision:record',
  // Revision requests (ACBP-P5-012; CDR-064 G5; TASK-005 lineage / J-13). OWNER-ONLY, because `API-CONTRACTS.md:55`
  // scopes the Documents row explicitly — "Member (read), owner (revise)" — and because a revision SPENDS a credit:
  // it starts a new metered run. Members read documents; the owner commits the company to more work. Reading a
  // revision's lineage is not this action; it rides the document read.
  'artifact:revise',
  // Planning (ACBP-P4-001; CDR-039; ROAD-001/002). Generation + read are member actions (the understanding:generate /
  // strategy:generate precedent); the versioned EDIT is owner-only (API-CONTRACTS "Owner (edit)").
  'roadmap:generate',
  'roadmap:read',
  'roadmap:edit',
  // Task planning (ACBP-P4-003; CDR-040; PLAN-001/002) — autonomous generation AND chat steering, both of which spend
  // metered model budget. Confirming a previewed draft reuses task:create (the existing planTask path).
  'task:generate',
  // Durable job enqueue (ACBP-P5-001a; CDR-049 §4). Its own action rather than folded into an existing generate-class
  // grant: enqueueing schedules work that will run LATER, outside the request that authorized it, and an action that
  // outlives its caller deserves a name of its own so tightening or widening it is a one-line policy change.
  'job:enqueue',
  // Running a durable job STEP (ACBP-P5-001b; CDR-050). Its own action rather than folded into `job:enqueue`, on the
  // `task:delete` precedent: scheduling work and executing it are different capabilities, and a named action makes a
  // future tightening — or granting it to a worker identity that may execute but never enqueue — a one-line policy
  // change instead of a refactor.
  'job:execute',
  // Task runs (ACBP-P5-002; CDR-053). TWO actions, split on the P5-001b precedent and for a sharper reason: a WORKER
  // must be able to start, heartbeat and finish a run, and must NEVER be able to cancel one - cancellation is the
  // owner's decision (API-CONTRACTS: run control is 'Owner/operator'). One action could not express that.
  'run:execute',
  'billing:read',
  'run:cancel',
  // Worker pause/disable per company (ACBP-P5-004; CDR-056; WORK-006). Canon calls it 'granular EMERGENCY control'
  // and puts it beside ADMIN-001: a viewer who could disable the research worker could stop the company's work
  // without being able to start any. Owner-only.
  'worker:control',
  // Policy configuration (ACBP-P6-001c; CDR-066 §6-G17; ADR-010). OWNER-ONLY, and deliberately NOT folded into
  // `run:execute`: deciding what a company is allowed to do is a different authority from doing it. A worker holds
  // `run:execute`, and a worker able to rewrite the policy it is about to be judged by would make the whole
  // authority chain circular — invariant 5's shape, one layer down. Evaluation itself rides `run:execute`, because
  // it happens on the execution path on behalf of a run.
  'policy:manage',
  // Approvals (ACBP-P6-003c; CDR-068; APPR-002/003/007; invariant 5). THREE actions, not one, because they answer
  // three different questions and collapsing them would grant the wrong thing:
  //   `approval:request` — MAY THIS RUN ASK? It rides the execution path, so it belongs to whoever may execute.
  //   `approval:decide`  — MAY THIS PERSON AUTHORIZE? This is the authority chain's hinge (invariant 5).
  //   `approval:read`    — MAY THIS PERSON SEE THE INBOX? A viewer watching what is pending is not a risk; a viewer
  //                        who could approve it is.
  //   `approval:revoke`  — MAY THIS PERSON TAKE AN AUTHORIZATION BACK? Separate from `decide` because it is a
  //                        different act at a different time: deciding answers a question that was asked, revoking
  //                        withdraws an answer already given (ACBP-P6-004; APPR-006).
  'approval:request',
  'approval:decide',
  'approval:revoke',
  'approval:read',
  // Emergency stop (ACBP-P6-007; CDR-072; ADMIN-001/002). THREE actions, and the split is not cosmetic:
  //   `stop:activate` — MAY THIS PERSON HALT THE PLATFORM? A safety action. Owner-only, but note the asymmetry
  //                     below: nothing about activation may fail closed INTO running.
  //   `stop:clear`    — MAY THIS PERSON LIFT A HALT? A different and strictly more dangerous authority than
  //                     activating one. Collapsing the two would mean anyone who can stop can also un-stop, which
  //                     is the wrong default for a control whose entire purpose is to be hard to undo by accident.
  //   `stop:read`     — MAY THIS PERSON SEE WHAT IS HALTED? Seeing a stop is not a risk; lifting it is. Mirrors
  //                     the `approval:read` split for the same reason.
  'stop:activate',
  'stop:clear',
  'stop:read',
  // Account usage rollups (ACBP-P6-009; CDR-073; USAGE-001 amended). TWO actions, both ACCOUNT-level — checked
  // against the caller's active ACCOUNT-membership role, like `portfolio:read`, because a rollup spans the
  // account's companies and no company role can answer a question about all of them.
  //   `usage:read`    — MAY THIS PERSON SEE THE ACCOUNT'S USAGE? `API-CONTRACTS` is explicit: *"account rollup =
  //                     account owner"*. Owner-only, and NOT widened to viewer the way `stop:read` and
  //                     `approval:read` were: those disclose that work is halted or pending, whereas this
  //                     discloses spend across the whole account, which canon assigns to the owner alone.
  //   `usage:correct` — MAY THIS PERSON WRITE A COMPENSATING USAGE RECORD? A correction changes a billing-relevant
  //                     figure, so it is owner-only and DISTINCT from reading. It never edits: the correction is
  //                     a new append-only row referencing the original (CDR-073 §1-G9; trust-critical #13).
  // There is deliberately NO `usage:rebuild` action. Whether an account owner may trigger a rebuild on demand or
  // whether it is platform-only is an OPEN OWNER DECISION (CDR-073 §3.2); registering an action now would encode
  // an answer nobody has given. Until it is ruled, rebuild is a core use case with no API surface.
  'usage:read',
  'usage:correct',
  // Decision Room entry (ACBP-P6-008; CDR-076 §3-G2; DEC-001). ONE action, and it grants NOTHING new: it is the
  // same authority class as `activity:read` (any active company member), because the room is a composed READ over
  // surfaces this member could already read one at a time. It exists as its own name rather than reusing
  // `activity:read` so the room can later be narrowed without narrowing the feed — and so a reader of this matrix
  // can see that entering the room is a distinct, auditable decision.
  // Each SECTION inside the room additionally re-checks its own domain action (`approval:read`, `stop:read`,
  // `usage:read`), unchanged and un-widened; a section the caller lacks renders as `restricted`, never as empty.
  'decision_room:read',
  // Export of owned data (ACBP-P7-001; CDR-078; EXPORT-001). OWNER-ONLY, and narrower than the reads it composes:
  // an export moves a copy of everything the company owns OUT of the platform's control, to a destination it will
  // never see again. A viewer who may READ the understanding in-product is not thereby entitled to walk out with
  // an archive of it — API-CONTRACTS `:77` says Owner, and this is one of the places where "can see" and "can
  // take" genuinely differ.
  'export:create',
] as const;
export type AuthzAction = (typeof AUTHZ_ACTIONS)[number];

/** Runtime type guard for an action value arriving from untrusted input (deny-by-default at the boundary). */
export function isAuthzAction(value: unknown): value is AuthzAction {
  return typeof value === 'string' && (AUTHZ_ACTIONS as readonly string[]).includes(value);
}

/**
 * Coarse, SERVER-SIDE-ONLY denial reasons (for audit only; NEVER mapped into public output — a denial must
 * not reveal the caller's role, membership state, or whether an action exists). `not_a_member` = null role
 * (no active membership); `insufficient_role` = a valid role that lacks the action; `unknown_action` = an
 * action outside the closed set (defensive).
 */
export type AuthzDenialReason = 'not_a_member' | 'insufficient_role' | 'unknown_action';

/** Explicit allow/deny union. A deny carries the coarse server-side reason (audit only). */
export type AuthzDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: AuthzDenialReason };

export const ALLOW: AuthzDecision = { kind: 'allow' };
export function deny(reason: AuthzDenialReason): AuthzDecision {
  return { kind: 'deny', reason };
}
export function isAllowed(decision: AuthzDecision): boolean {
  return decision.kind === 'allow';
}

/**
 * Role→action policy matrix. Deny-by-default: each action lists EXACTLY the roles allowed to perform it; a
 * role absent from the list is denied. Owner ⊇ viewer is NOT assumed — every allowance is explicit, so a
 * new action defaults to owner-only-if-listed rather than silently inheriting broad access.
 */
const POLICY: Record<AuthzAction, readonly AuthzRole[]> = {
  'member:invite': ['owner'],
  'member:revoke': ['owner'],
  'member:list': ['owner', 'viewer'],
  'member:read_invited_email': ['owner'],
  'profile:read': ['owner'],
  'profile:update': ['owner'],
  // Company lifecycle: owner-only mutations; owner+viewer may read/see status (CDR-015; WORKFLOW §1 "owner"
  // transitions; API-CONTRACTS "Member (read), owner (lifecycle)").
  'company:create': ['owner'],
  'company:read': ['owner', 'viewer'],
  'company:rename': ['owner'],
  'company:pause': ['owner'],
  'company:resume': ['owner'],
  'company:status': ['owner', 'viewer'],
  // Company activity feed read (ACBP-P1-009): any active company member (owner|viewer) — API-CONTRACTS
  // "Activity … Company member (read)". Account membership alone is insufficient (the company role governs).
  'activity:read': ['owner', 'viewer'],
  // Company portfolio read (ACBP-P1-011; CDR-017 §7): any active ACCOUNT member (owner|viewer). This role check
  // authorizes the API call only; the listing itself is intersected with the caller's active company memberships.
  'portfolio:read': ['owner', 'viewer'],
  // Workspace provisioning (ACBP-P1-012; CDR-018 §11): status read = any active company member; resume = company
  // owner only (a lifecycle-mutation-class operation — it can ultimately activate the company).
  'provisioning:read': ['owner', 'viewer'],
  'provisioning:resume': ['owner'],
  // Platform-administrative access (ACBP-P1-013; CDR-019): EMPTY allow-list — no membership role may ever
  // perform it through this matrix. The separate platform_admins gate is the only path (and it never consults
  // this matrix for a grant; the entry exists so the action name is closed and matrix-denied by construction).
  'admin:tenant_read': [],
  // Interview sessions (ACBP-P2-001; CDR-022 §6): read + participate = any active company member (owner|viewer).
  // API-CONTRACTS "Discovery interviews … Company member". Account membership alone is insufficient (the company
  // role governs). Confirmation (owner-only) is a separate future action, not part of this participate grant.
  'interview:read': ['owner', 'viewer'],
  'interview:participate': ['owner', 'viewer'],
  // Typed memory (ACBP-P2-006; CDR-024 §3): read + write = any active company member (owner|viewer). Edit/delete
  // (owner-only per API-CONTRACTS) are P2-010's separate actions, not part of this write grant.
  'memory:read': ['owner', 'viewer'],
  'memory:write': ['owner', 'viewer'],
  // Editing (a versioned correction) and deleting (a soft delete) are both OWNER-only (ACBP-P2-010;
  // API-CONTRACTS "Owner (edit/delete)").
  'memory:edit': ['owner'],
  'memory:delete': ['owner'],
  // Understanding generation (ACBP-P2-008; CDR-029): generate + read = any active company member (owner|viewer);
  // owner-only confirm is P2-009's separate action.
  'understanding:generate': ['owner', 'viewer'],
  'understanding:read': ['owner', 'viewer'],
  // Understanding review + confirmation (ACBP-P2-009; CDR-030): both OWNER-only (per-item decisions + correction, and
  // the overall confirm) — API-CONTRACTS "Owner (confirm)", UNDER-003 "Owner-only confirm".
  'understanding:review': ['owner'],
  'understanding:confirm': ['owner'],
  // Task model (ACBP-P4-002; CDR-033): create/plan + read = any active company member (owner|viewer). The owner-only
  // RUN trigger (planned→queued) is a later ticket's separate action.
  'task:create': ['owner', 'viewer'],
  'task:read': ['owner', 'viewer'],
  // Task deletion (ACBP-P4-005; CDR-043): owner|viewer, matching create. Canon scopes TASK-008 to "Company-scoped"
  // and says nothing about role, so restricting it to the owner would invent a requirement — and a member who may
  // create work should be able to withdraw it. The deletion is append-only and audited, so nothing is destroyed.
  'task:delete': ['owner', 'viewer'],
  // Strategy generation is a member action (like understanding:generate); owner-only selection is P3-004's action.
  'strategy:generate': ['owner', 'viewer'],
  'strategy:read': ['owner', 'viewer'],
  // Advisory recommendation is a member action (like strategy:generate); owner-only selection is P3-004's action.
  'strategy:recommend': ['owner', 'viewer'],
  // The owner-only strategy decision gate (STRAT-003 "owner-only selection"); the understanding:confirm precedent.
  'strategy:select': ['owner'],
  // The owner-only immutable decision-record write (STRAT-006; J-08 "Actor: owner") — the strategy:select precedent.
  'decision:record': ['owner'],
  // Revision requests are OWNER-ONLY (ACBP-P5-012; CDR-064 G5). `API-CONTRACTS.md:55` scopes the Documents row
  // explicitly - "Member (read), owner (revise)" - so unlike `task:delete` this is not a case where canon is silent
  // and restricting would invent a requirement. It also spends a credit, which is the strategy:select precedent.
  'artifact:revise': ['owner'],
  // Roadmap generation/read are member actions (like understanding:generate / strategy:generate).
  'roadmap:generate': ['owner', 'viewer'],
  'roadmap:read': ['owner', 'viewer'],
  // The versioned roadmap EDIT is owner-only (API-CONTRACTS "Owner (edit)"; ROAD-002 records author + reason).
  'roadmap:edit': ['owner'],
  // Task planning is a member action (the generate-class precedent); the tasks it mints are DRAFTS, not board work.
  'task:generate': ['owner', 'viewer'],
  // Durable job enqueue (ACBP-P5-001a; CDR-049 §4) is OWNER-ONLY, deliberately the tighter of the two readings.
  // Canon does not settle the role for P5-001 the way it settles STRAT-003, so this picks the SAFER REVERSIBLE
  // interpretation the charter calls for: widening later is additive and breaks nothing, whereas discovering that
  // viewers have been scheduling background execution is not recoverable after the fact. Enqueue also differs from
  // the generate-class member actions in kind — those spend budget INSIDE the request that authorized them, while a
  // job runs later, on its own, after the authorizing session is gone.
  'job:enqueue': ['owner'],
  // Step execution (ACBP-P5-001b) is owner-only for the same reason as enqueue, and by the same safer-reversible
  // reading. When P5-002 introduces a worker identity, THAT is what should hold this action — which is precisely the
  // change a separate action makes cheap.
  'job:execute': ['owner'],
  // Task runs (ACBP-P5-002; CDR-053). Both owner-only today. When P5-002's worker identity lands, run:execute is
  // what it receives - and run:cancel is precisely what it must not: cancelling is the owner's decision, and a
  // worker able to cancel its own run could hide work it had been told to stop.
  'run:execute': ['owner'],
  // The credit ledger read (ACBP-P5-014; CDR-058 §2). OWNER-ONLY, and for a reason specific to this table: the
  // ledger is ACCOUNT-scoped, so it spans every company in the account. A company-scoped operator reading it would
  // learn what the account's OTHER companies have been spending. The RLS predicate cannot stop that — it is keyed on
  // the account deliberately — so this action is the only control, and it is the strict one.
  'billing:read': ['owner'],
  'run:cancel': ['owner'],
  'worker:control': ['owner'],
  // Owner-only (CDR-066 §6-G17). A viewer who could set the policy could widen what the AI may do unsupervised.
  'policy:manage': ['owner'],
  // Requesting rides the EXECUTION path — a run that hits a `require_approval` decision must be able to raise the
  // request, and the same roles that may execute may raise it. Mirrors `run:execute` deliberately: if these two ever
  // diverge, a run could be authorized to act but not to ask, which is a deadlock disguised as a permission.
  'approval:request': ['owner'],
  // OWNER-ONLY, and this is the line invariant 5 rests on at the role layer. The actor TYPE restriction (human or
  // delegated) is enforced in the contract and by a database CHECK; this is the orthogonal question of WHICH member
  // may exercise the authority. A viewer who could decide would be able to authorize spending and external actions
  // they were never given authority over. Delegation is P6-005's; until it exists, only the owner decides.
  'approval:decide': ['owner'],
  // OWNER-ONLY, for the same reason and one more. Revocation is the only way to take back an authorization that has
  // not yet been spent, so a role that could revoke could halt work the owner authorized — and a role that could
  // NOT revoke while being able to decide would be able to authorize irreversibly. Keeping the two at the same
  // level means whoever can grant can also withdraw, which is the property that makes an approval retractable
  // rather than a one-way door.
  'approval:revoke': ['owner'],
  // VIEWERS may read the inbox. Seeing what is waiting is how a team knows the AI is blocked, and hiding it would
  // make the queue invisible to exactly the people wondering why nothing is happening — the same reasoning
  // `listWorkers` was made viewer-readable on (CDR-056). Reading a pending request is not authority over it: the
  // decide action above is owner-only, so a viewer can see that something needs a human without being that human.
  'approval:read': ['owner', 'viewer'],
  // Emergency stop (ACBP-P6-007; CDR-072 §1-G9; ADMIN-001/002). Activating and clearing are both OWNER-ONLY, and
  // they are separate actions rather than one so a later role model can widen who may HALT without also widening
  // who may UN-halt. Those two are not symmetric: stopping is a safety action whose worst case is lost work,
  // whereas clearing is what lets the AI act again.
  'stop:activate': ['owner'],
  'stop:clear': ['owner'],
  // VIEWERS may see what is halted, for the same reason they may read the approval inbox: a team wondering why
  // nothing is running should be able to find out that a stop is in force. Seeing a halt is not authority over it —
  // `stop:clear` above is owner-only, so a viewer can learn the platform is stopped without being able to restart
  // it. Hiding it would make the single most important operational fact invisible to the people asking about it.
  'stop:read': ['owner', 'viewer'],
  // Account usage (ACBP-P6-009; CDR-073). Both OWNER-ONLY, per `API-CONTRACTS`' "account rollup = account owner".
  // A viewer is deliberately excluded from BOTH: unlike a halted-work or pending-approval read, these disclose
  // (and in `usage:correct`'s case alter) the account's spend.
  'usage:read': ['owner'],
  'usage:correct': ['owner'],
  // Decision Room entry (ACBP-P6-008; CDR-076 §3-G2; DEC-001): any active COMPANY member (owner|viewer) — exactly
  // `activity:read`'s allow-list, and deliberately not one role wider. The room composes reads the member already
  // has; the owner-only surfaces inside it (usage) keep their own owner-only action and render as `restricted`,
  // so entering the room can never become a back door around a narrower action.
  'decision_room:read': ['owner', 'viewer'],
  // Owner only. See the note on the action above: reading in-product and taking a copy away are different powers.
  'export:create': ['owner'],
};

/**
 * Pure authorization decision for the internal role-check step. `role` is the caller's SERVER-RESOLVED
 * active-membership role (`null` = no active membership). Deny-by-default at every branch:
 *   - `null` role → deny(`not_a_member`);
 *   - action outside the closed policy set → deny(`unknown_action`);
 *   - role not in the action's allow-list → deny(`insufficient_role`).
 */
export function authorize(role: AuthzRole | null, action: AuthzAction): AuthzDecision {
  if (role === null) return deny('not_a_member');
  // Defensive: tolerate an action forced past the type boundary (e.g. via a cast at an untrusted seam).
  const allowed = POLICY[action] as readonly AuthzRole[] | undefined;
  if (allowed === undefined) return deny('unknown_action');
  return allowed.includes(role) ? ALLOW : deny('insufficient_role');
}

/**
 * Safe, client-facing envelope for ANY authorization denial — ALWAYS the same opaque `authz` /
 * `AUTHORIZATION_DENIED` (403) envelope regardless of the private reason, so a denial never becomes a
 * role/membership/existence oracle. The reason stays server-side (audit only).
 */
export function authorizationDeniedEnvelope(correlationId?: string): PublicErrorEnvelope {
  return platformError('authz', {
    code: ErrorCodes.AUTHORIZATION_DENIED,
    ...(correlationId !== undefined ? { correlationId } : {}),
  }).toPublic();
}
