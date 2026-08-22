// @acbp/adapters — the owner-presence gate on live, paid model calls (AGENTS.md §1; adopted from PR #109).
//
// THE RULE. Once `ANTHROPIC_API_KEY` exists in the environment, that is a CREDENTIAL, not a permission. No live
// call may happen without the owner present and saying "run it" for THAT SPECIFIC CALL — every time, not only the
// first time. It holds regardless of automation level, and holds until the credit-reservation ledger is wired to
// the generate routes (ACBP-API-009; CDR-096 records why that ticket cannot ship as written).
//
// WHY THIS FILE EXISTS AT ALL. Until now the rule lived only as a paragraph in AGENTS.md — prose, which an agent
// can read past, and which no test can fail. This repository has already recorded four guards that were green
// while their defect was live and six comments that asserted guarantees nothing enforced. A money rule defended
// only by a sentence is that pattern with a bill attached.
//
// ⚠️ WHAT THIS IS AND IS NOT. It is a TRIPWIRE against an accidental or automatic paid call: the live path fails
// closed, so making a real call requires a deliberate, visible, single-use act. It is NOT a defence against an
// agent that decides to call `grantLiveCalls()` itself — nothing inside a repository can stop code that is free to
// edit the repository. Claiming otherwise would be exactly the kind of unenforceable assertion this file exists to
// replace. What it removes is the failure mode where a live call happens because nobody stopped it.
//
// SINGLE USE IS THE WHOLE DESIGN. A grant that stayed valid would turn one human "yes" into an unbounded run of
// paid calls, which is the thing the rule forbids in its own wording.

/** What the gate is told about the call being authorized. Deliberately carries no credential and no prompt. */
export interface LiveCallContext {
  /** The resolved model id, for the operator-facing message. Never a credential. */
  readonly modelId: string;
}

/**
 * Authorization for live, paid model calls.
 *
 * `authorizeOneCall` either returns (authorized, and the authorization is CONSUMED) or throws. It deliberately
 * returns `void` rather than a boolean: a boolean invites `if (gate.authorizeOneCall(...))`, and a caller who
 * forgets the `if` gets a silent pass. A throw cannot be ignored by omission.
 */
export interface OwnerPresenceGate {
  authorizeOneCall(context: LiveCallContext): void;
}

/**
 * Thrown when a live call is attempted without an available authorization.
 *
 * A named class rather than a bare `Error` so callers and tests identify the condition without matching message
 * text — the message is written for a human operator and should stay free to improve.
 */
export class LiveCallNotAuthorizedError extends Error {
  readonly modelId: string;

  constructor(modelId: string, reason: string) {
    super(
      `Refusing a live, paid model call to ${modelId}: ${reason}. ` +
        'AGENTS.md §1 requires the owner to be present and to authorize each live call individually — every ' +
        'call, not only the first. Obtain a grant for this specific call rather than widening the default.',
    );
    this.name = 'LiveCallNotAuthorizedError';
    this.modelId = modelId;
  }
}

/**
 * The default gate: refuses every live call.
 *
 * Refusal holds no state, so it cannot be exhausted, wrapped around, or worn down by repetition — a "refuse"
 * implemented as a counter starting at zero would be one underflow away from permitting everything.
 */
export function refuseAllLiveCalls(): OwnerPresenceGate {
  return {
    authorizeOneCall(context: LiveCallContext): void {
      throw new LiveCallNotAuthorizedError(context.modelId, 'no owner authorization was supplied for this call');
    },
  };
}

/**
 * A grant for exactly `count` live calls, consumed one per call.
 *
 * `count` is validated rather than coerced. A negative or fractional count is a caller bug, and silently rounding
 * it would turn a mistake into a spending decision. Zero is a refusal — stated explicitly because `remaining > 0`
 * and `remaining !== 0` differ only in that case, and that is where an off-by-one would hide.
 *
 * State is per-gate, held in this closure. Module-level state would let one call site consume another's grant.
 */
export function grantLiveCalls(count = 1): OwnerPresenceGate {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`grantLiveCalls: count must be a non-negative integer, received ${String(count)}`);
  }

  let remaining = count;

  return {
    authorizeOneCall(context: LiveCallContext): void {
      if (remaining <= 0) {
        throw new LiveCallNotAuthorizedError(
          context.modelId,
          count === 0
            ? 'the grant was for zero calls'
            : `the grant of ${String(count)} call(s) is exhausted — each live call needs its own authorization`,
        );
      }
      remaining -= 1;
    },
  };
}
