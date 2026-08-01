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
 *
 * ⚠️ **SEVEN ARE NAMED; ONLY FIVE ARE ENFORCEABLE IN THIS RELEASE.** `capability` and `integration` are storable
 * and **INERT** — the tool registry carries no identity for either, so no call can be matched against them. They
 * are refused at activation (§1-G10) and a stored one DENIES rather than being ignored. Do not read this array as
 * "seven working scopes": use {@link ENFORCEABLE_STOP_SCOPES} for anything that decides or displays what a stop
 * can actually halt.
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

/**
 * Scopes the dispatcher CANNOT resolve yet, and which must therefore be refused at activation (CDR-072 §1-G10).
 *
 * The covering relation needs an identity per scope. The tool registry carries `risk_class` and `external_effect`
 * and NOTHING that identifies a capability or an integration — no column on `tool_registrations`, no call fact. So
 * a `capability` or `integration` stop cannot be matched against any call today.
 *
 * ACCEPTING ONE WOULD BE THE WORST OUTCOME AVAILABLE HERE: the operator activates it, sees it recorded, believes it
 * is in force — and it can never match a single call. That is CDR-072 §0's failure exactly, introduced by the
 * ticket meant to prevent it. Refused BY NAME instead, as ACBP-P6-006 refuses autonomy levels 3–5 rather than
 * clamping them.
 *
 * REVERSIBLE IN ONE LINE: when the registry gains a capability/integration identity, empty this list and add the
 * two matrix cases. `isEnforceableStopScope` is derived from it, so nothing else has to be found and changed.
 */
export const NOT_YET_ENFORCEABLE_STOP_SCOPES: readonly StopScope[] = ['capability', 'integration'];

/** The scopes the dispatcher can actually honour. DERIVED, so it cannot drift from the list above. */
export const ENFORCEABLE_STOP_SCOPES: readonly StopScope[] = STOP_SCOPES.filter((s) => !NOT_YET_ENFORCEABLE_STOP_SCOPES.includes(s));

export function isEnforceableStopScope(value: unknown): value is StopScope {
  return isStopScope(value) && !NOT_YET_ENFORCEABLE_STOP_SCOPES.includes(value);
}

/**
 * One activated stop. `targetId` names WHAT is stopped for the identity-based scopes; it is null for the rest.
 *
 * `scope` IS TYPED `string`, NOT `StopScope`, AND THAT IS DELIBERATE. These rows come from a database, and a
 * database can hold a value no TypeScript union knows about — a hand-written row, a future migration, a scope this
 * release has never heard of. Narrowing the type here would push the validation onto the caller and let a cast
 * paper over exactly the case `evaluateStops` exists to catch: it guards with `isStopScope` and returns
 * `unreadable` for anything unrecognised, which only works if unrecognised values can actually reach it.
 */
export interface StopRecord {
  readonly scope: string;
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
  | { readonly kind: 'unreadable'; readonly reason: 'unknown_scope' | 'missing_target' | 'scope_not_enforceable' };

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

    // A STORED STOP THIS RELEASE CANNOT ENFORCE MUST DENY, NOT BE IGNORED. Without this branch a `capability` stop
    // would be compared against a `capabilityId` the dispatcher can never populate, fail to match, and read as
    // CLEAR — a stop the operator activated, that is sitting in the database, silently permitting everything. That
    // is CDR-072 §0's failure hiding inside the very function written to prevent it.
    //
    // The service refuses to create these (§1-G10), so this should be unreachable through the product path — which
    // is exactly why it is here: the branch guards against a row arriving some other way, and being wrong here
    // means a halt the operator believes in doing nothing at all.
    if (!isEnforceableStopScope(record.scope)) return { kind: 'unreadable', reason: 'scope_not_enforceable' };

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
