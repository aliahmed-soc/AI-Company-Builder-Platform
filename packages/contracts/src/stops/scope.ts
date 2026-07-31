// @acbp/contracts — emergency-stop scopes and the covering relation (ACBP-P6-007a; CDR-072; ADMIN-001;
// invariant 14; diagrams/13-emergency-stop.mmd). Zero-dep and PURE.
//
// THE FAILURE THIS MODULE IS WRITTEN AGAINST (CDR-072 §0): a stop that silently fails to reach one scope is worse
// than no stop at all, because the operator believes it worked and stops watching. Every decision below is made
// against that, not against the happy path.
//
// PURE, so the halt is a function of its arguments and can be exhaustively tested. The STORE is a later slice; a
// covering rule that needed a database could not be proven over the whole matrix.

/**
 * The seven stop scopes, from `diagrams/13-emergency-stop.mmd`'s own legend. CLOSED, and ordered narrowest →
 * broadest so a reader can see that breadth is the axis.
 */
export const STOP_SCOPES = [
  'task',
  'worker',
  'capability',
  'integration',
  'company',
  'external_actions_only',
  'account_wide',
] as const;
export type StopScope = (typeof STOP_SCOPES)[number];

export function isStopScope(value: unknown): value is StopScope {
  return typeof value === 'string' && (STOP_SCOPES as readonly string[]).includes(value);
}

/** One activated stop. `targetId` names WHAT is stopped for the identity-based scopes; it is null for the rest. */
export interface StopRecord {
  readonly scope: StopScope;
  readonly targetId: string | null;
}

/**
 * The facts a stop is evaluated against. Every field comes from the REGISTRY or the call's own identity — never
 * from model text, per ADR-010 §5's rule for trust-critical determinations.
 */
export interface StoppableCall {
  readonly taskId: string | null;
  readonly workerId: string | null;
  readonly capabilityId: string | null;
  readonly integrationId: string | null;
  /** From the tool registry's side-effect class, not from anything a model said. */
  readonly hasExternalEffect: boolean;
  /** Present so a company-scoped stop can be matched explicitly rather than assumed from the query's scoping. */
  readonly companyId?: string | null;
}

/**
 * The answer. `stopped` NAMES THE SCOPES THAT COVERED THE CALL (CDR-072 §1-G5) — an operator reading the record
 * afterwards needs to know WHAT stopped, not that someone pressed something.
 */
export type StopEvaluation =
  | { readonly kind: 'stopped'; readonly scopes: readonly StopScope[] }
  | { readonly kind: 'clear' }
  | { readonly kind: 'unreadable'; readonly reason: 'unknown_scope' | 'missing_target' };

/** Scopes whose meaning is "this specific thing", and which are therefore meaningless without a target. */
const IDENTITY_SCOPES: readonly StopScope[] = ['task', 'worker', 'capability', 'integration', 'company'];

function targetOf(scope: StopScope, call: StoppableCall): string | null | undefined {
  switch (scope) {
    case 'task':
      return call.taskId;
    case 'worker':
      return call.workerId;
    case 'capability':
      return call.capabilityId;
    case 'integration':
      return call.integrationId;
    case 'company':
      return call.companyId ?? null;
    default:
      return undefined;
  }
}

/**
 * Evaluate every active stop against one call.
 *
 * A MALFORMED RECORD MAKES THE WHOLE EVALUATION UNREADABLE, and that is the load-bearing decision here. A
 * scoped stop with no target could be read two ways, and BOTH are wrong:
 *
 *   - "covers nothing" — the stop silently does nothing while the operator believes it worked. That is CDR-072
 *     §0's failure exactly.
 *   - "covers everything" — an over-halt, which turns a targeted control into an outage nobody asked for.
 *
 * So it is neither. It is UNREADABLE, and the dispatcher already turns unreadable stop state into
 * `stop_unavailable` → denied, on canon's own principle that *"no stop is recorded" is a complete answer; "I could
 * not check" is not*. Unreadable is also checked BEFORE any covering match is returned, so a corrupt record cannot
 * hide behind a working one and leave the store's corruption undiscovered.
 */
export function evaluateStops(stops: readonly StopRecord[], call: StoppableCall): StopEvaluation {
  const covering: StopScope[] = [];

  for (const record of stops) {
    if (!isStopScope(record?.scope)) return { kind: 'unreadable', reason: 'unknown_scope' };

    const scope = record.scope;
    if (IDENTITY_SCOPES.includes(scope)) {
      const target = typeof record.targetId === 'string' ? record.targetId.trim() : '';
      if (target === '') return { kind: 'unreadable', reason: 'missing_target' };
      if (targetOf(scope, call) === target) covering.push(scope);
      continue;
    }

    // `external_actions_only` covers by EFFECT, not identity — the tool reaches outside the platform or it does
    // not. `account_wide` covers unconditionally, which is why a call with no attachments cannot escape it.
    if (scope === 'external_actions_only') {
      if (call.hasExternalEffect) covering.push(scope);
      continue;
    }
    covering.push('account_wide');
  }

  return covering.length > 0 ? { kind: 'stopped', scopes: covering } : { kind: 'clear' };
}
