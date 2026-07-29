// @acbp/contracts — the credit ledger's arithmetic and charging rules (ACBP-P5-014; CDR-058; BILL-002; TASK-004).
// Zero-dep and PURE. No clock, no database, no ordering assumption: a ledger's sum must not depend on the order rows
// come back in.
//
// THE BALANCE IS DERIVED. Canon is explicit — *"Balance is always derived"* (`USAGE-AND-BILLING §2`) — so there is no
// stored total anywhere. A cached total would be a second source of truth, and the moment it disagreed with the ledger
// nobody could say which was right. The derivation itself is a SQL `sum` in `CreditRepository`, not a function here:
// a ledger grows without bound and only its sum is ever needed. What lives in this module is the SIGN CONVENTION that
// makes that sum correct.
import { validationError } from '../errors.js';

/**
 * CLOSED. Canon's five (`USAGE-AND-BILLING §2`): *"grants (plan reset, bonus, purchase), reservations (run preflight),
 * consumptions (run completion), releases (cancel), refunds/corrections"*.
 *
 * A sixth kind is not a small addition — an unrecognised kind would sum into someone's balance unexamined, which is
 * why `signedAmount` throws on one rather than picking a sign.
 */
export const CREDIT_ENTRY_KINDS = ['grant', 'reservation', 'consumption', 'release', 'correction'] as const;
export type CreditEntryKind = (typeof CREDIT_ENTRY_KINDS)[number];

export function isCreditEntryKind(value: unknown): value is CreditEntryKind {
  return typeof value === 'string' && (CREDIT_ENTRY_KINDS as readonly string[]).includes(value);
}

/**
 * Does this kind ADD credits back?
 *
 * A `correction` deliberately is NOT one, even though it can be positive: it compensates whatever was wrong, in either
 * direction (invariant 10). Classing it as a grant would give it a guaranteed positive sign — a correction that could
 * only ever mint.
 */
export function isCreditGrantKind(value: unknown): boolean {
  return value === 'grant' || value === 'release';
}

/**
 * The MVP rule: *"one manual task run = one credit"* (`USAGE-AND-BILLING §1`, TASK-004/BILL-002 evidence).
 *
 * A CONSTANT, not a column default and not a CHECK. **D-02 is open** — whether pricing stays task-credits, moves to
 * usage-billing or hybridizes is undecided, and canon requires the ledger to support all three *"without schema
 * change"*. A rule baked into the schema would have to be migrated away; a rule in code is one edit.
 */
export const CREDITS_PER_MANUAL_RUN = 1;

function requireWholeCredits(amount: unknown, allowNegative: boolean): number {
  if (typeof amount !== 'number' || !Number.isInteger(amount)) {
    throw validationError({ message: 'Credit amount must be a whole number of credits.', fields: ['credits'] });
  }
  if (!allowNegative && amount < 0) {
    throw validationError({ message: 'Credit amount must not be negative.', fields: ['credits'] });
  }
  return amount;
}

/**
 * The signed amount a ledger row contributes.
 *
 * THE SIGN CONVENTION IS THE ARITHMETIC: with signed rows the balance is `SUM(amount)` and nothing else. If the sign
 * lived in the reader instead, every future caller would have to remember which kinds subtract, and the one that
 * forgot would compute a plausible, wrong number that no test would obviously catch.
 *
 * A negative magnitude on a non-correction THROWS rather than being flipped: a negative grant is a spend wearing a
 * grant's name, and coercing it would bury a caller's bug inside someone's balance.
 */
export function signedAmount(kind: unknown, credits: number): number {
  if (!isCreditEntryKind(kind)) {
    throw validationError({ message: 'Credit entry kind is not recognised.', fields: ['kind'] });
  }
  // A correction carries its own sign — that is what compensating in either direction means.
  if (kind === 'correction') return requireWholeCredits(credits, true);
  const magnitude = requireWholeCredits(credits, false);
  const signed = isCreditGrantKind(kind) ? magnitude : -magnitude;
  // Normalise `-0` to `0`. A zero-magnitude spend is legitimate (a consumption finalises a hold without moving
  // credits — D9), and `-0` would sum correctly but compare unequal under `Object.is`, so it would read as a
  // different number in exactly the assertions meant to police this.
  return signed === 0 ? 0 : signed;
}

// NO `deriveBalance` HERE, deliberately. An earlier version had one and it was both DEAD and WRONG: the repository
// sums the SIGNED stored value, while the contract version expected unsigned magnitudes and applied the sign itself —
// so the two disagreed on every spend row, and its fixtures used rows the sign CHECK makes impossible to insert. A
// unit suite was validating a ledger that cannot exist, and nothing in production called it. The SQL sum in
// `CreditRepository.deriveBalance` is the only balance there is.

/** Can this balance cover this cost? Deny-by-default: anything unreadable on either side affords nothing. */
export function canAfford(balance: unknown, cost: unknown): boolean {
  if (typeof balance !== 'number' || !Number.isFinite(balance) || balance < 0) return false;
  if (typeof cost !== 'number' || !Number.isInteger(cost) || cost <= 0) return false;
  return balance >= cost;
}

export type RunSettlement = { readonly kind: 'consume' } | { readonly kind: 'release' } | { readonly kind: 'hold' };

/**
 * What becomes of a run's reservation, per canon's charging rules (`USAGE-AND-BILLING §4`).
 *
 * NO FAILURE CATEGORY PARAMETER, deliberately. Canon's table is generous and lists no failure that consumes: a
 * provider fault releases, an invalid output after re-asks releases (*"counts against quality metrics, not the
 * customer"*), and a cancellation releases (*"MVP-generous; revisit with D-02"*). Since **every** failure releases,
 * a category argument would sit in the signature unread — a reader would reasonably assume it changed the answer, and
 * a later caller would pass one expecting it to matter. That is the "written but not applied" defect this codebase
 * has now hit on four consecutive tickets, so the argument is simply absent until canon distinguishes a case.
 *
 * Technical usage is still recorded on every path; it is the CREDIT that is released.
 *
 * UNRECOGNISED OUTCOMES HOLD. Holding is the only reversible answer — a later settlement can still consume or release
 * — whereas guessing `consume` charges someone for work that may not have happened, and guessing `release` gives real
 * work away. Fail closed here means fail *unchanged*.
 */
export function decideRunSettlement(outcome: unknown): RunSettlement {
  if (outcome === 'succeeded') return { kind: 'consume' };
  // `cancelled` and `failed` both release. Listed separately rather than collapsed, because they are different facts
  // about what happened and the day canon charges for one of them, this is the line that changes.
  if (outcome === 'cancelled') return { kind: 'release' };
  if (outcome === 'failed') return { kind: 'release' };
  return { kind: 'hold' };
}

/**
 * The MAGNITUDE a settlement row contributes, given what its reservation reserved.
 *
 * D9 — A CONSUMPTION MOVES NO CREDITS. The reservation already debited them; that is what reserving IS. Settling a
 * succeeded run only records that the hold became a real spend, so its magnitude is **zero** and the balance is
 * unchanged by it. Before this, `consumption` took the reservation's magnitude with a spend's negative sign, so a
 * SUCCEEDED run wrote `reservation -1` AND `consumption -1` and cost **two** credits against canon's
 * *"one manual task run = one credit"* — while a FAILED run correctly cost none. Succeeding was the expensive outcome.
 *
 * A release, by contrast, genuinely moves credits: it returns exactly what was held.
 *
 * Not folded into {@link signedAmount}: that function's job is the SIGN of a kind and it is used for grants and
 * corrections that have no reservation at all. This is the separate question of how much a SETTLEMENT is worth, and
 * keeping them apart is what stops a future usage-billing consumption (D-02) from silently inheriting a rule written
 * for the flat-rate MVP.
 */
export function settlementMagnitude(kind: unknown, reservedMagnitude: number): number {
  const reserved = requireWholeCredits(reservedMagnitude, false);
  return kind === 'consumption' ? 0 : reserved;
}
