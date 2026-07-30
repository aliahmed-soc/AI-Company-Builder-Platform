// @acbp/contracts — the approval DECISION (ACBP-P6-003a; CDR-068 §2-G1/G3; APPR-007; invariant 5).
//
// Zero-dep and PURE.
//
// THIS MODULE'S WHOLE JOB IS TO MAKE ONE THING UNSAYABLE. Invariant 5 is the authority chain's non-negotiable
// property — *"the AI model can never mark its own action approved"* — and canon states the mechanism, not just the
// rule: *"approval decisions are writable only through the approval API, which rejects non-human/non-delegated actor
// types at the schema level; worker/model actors have no code path to it."*
//
// So the deciding actor is a TYPE that cannot express a worker, backed by a runtime guard for callers without a
// typechecker, and (P6-003b) a database CHECK for anything that reaches the table another way. Three layers, because
// P6-002's adversarial review found that the guarantees which survived attack were the structural ones.

/**
 * CLOSED. The five decision paths, in `API-CONTRACTS`'s order: *"approve, reject, edit-then-approve, schedule,
 * batch-approve"*.
 *
 * `revoke` appears in the same canon row and is deliberately ABSENT: revocation is ADR-009 §2's
 * consumption/revocation half and belongs to ACBP-P6-004. It is the easiest sixth path to add by accident, so its
 * absence is asserted by a test rather than left to memory.
 */
export const APPROVAL_DECISION_PATHS = ['approve', 'reject', 'edit_then_approve', 'schedule', 'batch_approve'] as const;
export type ApprovalDecisionPath = (typeof APPROVAL_DECISION_PATHS)[number];

export function isApprovalDecisionPath(value: unknown): value is ApprovalDecisionPath {
  return typeof value === 'string' && (APPROVAL_DECISION_PATHS as readonly string[]).includes(value);
}

/**
 * CLOSED, and NARROWER THAN THE AUDIT ACTOR SET ON PURPOSE.
 *
 * `AUDIT_ACTOR_TYPES` is `user | worker | system | admin`. Only two of those may decide an approval:
 *   - `human`     — a company member exercising their own authority.
 *   - `delegated` — someone acting under authority a company member granted (canon §1's "human or delegated").
 *
 * The three excluded ones are excluded for two different reasons, and the difference is worth stating:
 *   - `worker` is invariant 5 itself. A model actor deciding its own action is the failure the whole chain exists to
 *     prevent.
 *   - `system` and `admin` are not model actors, but neither is a company member exercising their own authority. A
 *     platform admin approving a company's action would be authority the owner never granted — and P1-013 confined
 *     admins to audited reads for exactly that reason. **This is the safer reading of a canon phrase ("human or
 *     delegated") that does not name admins either way, and it is reversible in one line** by adding a type here if
 *     the owner rules otherwise.
 */
export const APPROVAL_DECIDER_TYPES = ['human', 'delegated'] as const;
export type ApprovalDeciderType = (typeof APPROVAL_DECIDER_TYPES)[number];

export function isApprovalDeciderType(value: unknown): value is ApprovalDeciderType {
  return typeof value === 'string' && (APPROVAL_DECIDER_TYPES as readonly string[]).includes(value);
}

export interface ApprovalDecider {
  readonly type: ApprovalDeciderType;
  /** The internal user id. An anonymous approval is not an approval — accountability is the point of recording it. */
  readonly userId: string;
}

export interface ApprovalDecisionInput {
  readonly path: ApprovalDecisionPath;
  readonly decidedBy: ApprovalDecider;
  /** The instant of the decision. An INPUT, never read from the wall clock — see {@link authorizesExecution}. */
  readonly decidedAt: Date;
  /** `reject` only, and required there. */
  readonly reason?: string;
  /** `edit_then_approve` only, and required there: the human's replacement payload. */
  readonly editedData?: Readonly<Record<string, unknown>>;
  /** `schedule` only, and required there: when the authorization begins. */
  readonly effectiveFrom?: Date;
  /** `batch_approve` only, and required there: the enumerated members (canon — *"batch enumerates members"*). */
  readonly memberRequestIds?: readonly string[];
}

export interface ApprovalDecision {
  readonly path: ApprovalDecisionPath;
  readonly decidedBy: ApprovalDecider;
  readonly decidedAt: Date;
  readonly reason?: string;
  readonly editedData?: Readonly<Record<string, unknown>>;
  readonly effectiveFrom?: Date;
  readonly memberRequestIds?: readonly string[];
  /**
   * Does this decision replace the request it answers? True only for `edit_then_approve`.
   *
   * Canon §2's material-change rule: an edit creates a NEW bound payload and the old approval is *"superseded, never
   * mutated"* (invariant 7). The flag records the obligation; the rebinding is P6-004's.
   */
  readonly supersedes: boolean;
}

export type ParseApprovalDecisionResult =
  | { readonly status: 'ok'; readonly decision: ApprovalDecision }
  | { readonly status: 'actor_not_permitted' }
  | { readonly status: 'unknown_path'; readonly path: unknown }
  | { readonly status: 'missing_detail'; readonly path: ApprovalDecisionPath; readonly detail: string };

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}
function isUsableDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/**
 * Validate a decision, or refuse it.
 *
 * THE ACTOR IS CHECKED FIRST, and the refusal carries no detail about the path. A caller who is not entitled to
 * decide learns only that; telling them which fields a valid decision would have needed would be a small oracle on
 * an authority boundary.
 */
export function parseApprovalDecision(input: ApprovalDecisionInput): ParseApprovalDecisionResult {
  if (!isApprovalDeciderType(input.decidedBy?.type) || isBlank(input.decidedBy?.userId)) return { status: 'actor_not_permitted' };
  if (!isApprovalDecisionPath(input.path)) return { status: 'unknown_path', path: input.path };
  if (!isUsableDate(input.decidedAt)) return { status: 'missing_detail', path: input.path, detail: 'decidedAt' };

  // PER-PATH REQUIREMENTS. Each one exists because the path is meaningless without it, not for tidiness: a rejection
  // nobody can act on, an edit with nothing edited, a schedule with no instant, a batch naming nobody.
  switch (input.path) {
    case 'reject':
      if (isBlank(input.reason)) return { status: 'missing_detail', path: input.path, detail: 'reason' };
      break;
    case 'edit_then_approve':
      // AN EMPTY OBJECT IS NOT AN EDIT. `{}` passed every check — the type, the `is not null` CHECK, and this
      // branch — while meaning "I edited it, changing nothing", which is the incoherence the per-path detail
      // requirements exist to prevent. A human who edited nothing chose `approve`, and recording that as an edit
      // supersedes a request on the strength of a change that was never made.
      if (
        input.editedData === undefined ||
        input.editedData === null ||
        typeof input.editedData !== 'object' ||
        Array.isArray(input.editedData) ||
        Object.keys(input.editedData).length === 0
      ) {
        return { status: 'missing_detail', path: input.path, detail: 'editedData' };
      }
      break;
    case 'schedule':
      if (!isUsableDate(input.effectiveFrom)) return { status: 'missing_detail', path: input.path, detail: 'effectiveFrom' };
      break;
    case 'batch_approve':
      if (!Array.isArray(input.memberRequestIds) || input.memberRequestIds.length === 0) {
        return { status: 'missing_detail', path: input.path, detail: 'memberRequestIds' };
      }
      break;
    case 'approve':
      break;
  }

  const decision: ApprovalDecision = {
    path: input.path,
    decidedBy: { type: input.decidedBy.type, userId: input.decidedBy.userId },
    decidedAt: input.decidedAt,
    supersedes: input.path === 'edit_then_approve',
    // Optional keys are OMITTED rather than set to undefined — the AuditMetadata lesson from ACBP-P5-003b, where a
    // null in a flat-scalar payload threw and killed auditing for exactly one refusal path.
    ...(input.reason !== undefined && input.path === 'reject' ? { reason: input.reason } : {}),
    ...(input.editedData !== undefined && input.path === 'edit_then_approve' ? { editedData: input.editedData } : {}),
    ...(input.effectiveFrom !== undefined && input.path === 'schedule' ? { effectiveFrom: input.effectiveFrom } : {}),
    ...(input.memberRequestIds !== undefined && input.path === 'batch_approve' ? { memberRequestIds: [...input.memberRequestIds] } : {}),
  };
  return { status: 'ok', decision };
}

/**
 * Does this decision authorize execution AT `now`? TOTAL over `unknown`, and refusing by default.
 *
 * `reject` never authorizes. `approve`, `edit_then_approve` and `batch_approve` do.
 *
 * **`schedule` does NOT authorize before its instant.** That is the safer reading of a path canon does not spell out,
 * and it is the one that matches what a human means by scheduling: a promise about a future moment, not a present
 * authorization. Treating it as effective immediately would let someone who deliberately deferred an action find it
 * already done — the exact failure the Phase 6 bar is about.
 *
 * `now` IS A PARAMETER. Reading the wall clock here would make "was this authorized at time T?" unanswerable from the
 * record, the same reason CDR-066 §3-G3 keeps the policy evaluator's clock an input.
 *
 * A schedule with a missing or unreadable instant authorizes NOTHING. `parseApprovalDecision` refuses to build one,
 * so it can only arrive from a corrupt row — and the fail-closed reading of a corrupt schedule is "not yet".
 */
export function authorizesExecution(decision: { readonly path: unknown; readonly decidedAt?: unknown; readonly effectiveFrom?: unknown }, now?: Date): boolean {
  if (!isApprovalDecisionPath(decision.path)) return false;
  switch (decision.path) {
    case 'approve':
    case 'edit_then_approve':
    case 'batch_approve':
      return true;
    case 'schedule': {
      if (!isUsableDate(decision.effectiveFrom) || !isUsableDate(now)) return false;
      return now.getTime() >= decision.effectiveFrom.getTime();
    }
    case 'reject':
      return false;
  }
}
