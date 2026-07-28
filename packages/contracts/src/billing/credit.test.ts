// ACBP-P5-014 — the credit ledger's arithmetic and rules, made executable (CDR-058; BILL-002; TASK-004; invariant 10).
//
// The balance is DERIVED by a SQL sum, so what has to be right HERE is the SIGN CONVENTION that makes that sum mean
// anything. Everything is pure: no clock, no database.
import { describe, test, expect } from 'vitest';
import {
  CREDIT_ENTRY_KINDS,
  isCreditEntryKind,
  CREDITS_PER_MANUAL_RUN,
  signedAmount,
  decideRunSettlement,
  canAfford,
  isCreditGrantKind,
} from './credit.js';

describe('entry kinds', () => {
  test('are exactly canon\'s five: grant · reservation · consumption · release · correction', () => {
    // USAGE-AND-BILLING §2 lists them: "grants ..., reservations ..., consumptions ..., releases ...,
    // refunds/corrections". Five kinds, no more — an unlisted kind would sum into the balance unexamined.
    expect([...CREDIT_ENTRY_KINDS]).toEqual(['grant', 'reservation', 'consumption', 'release', 'correction']);
    for (const k of CREDIT_ENTRY_KINDS) expect(isCreditEntryKind(k)).toBe(true);
    for (const bad of ['spend', 'refund', '', null, undefined, 3]) expect(isCreditEntryKind(bad)).toBe(false);
  });

  test('only a grant and a release ADD credits back; the rest never do', () => {
    // A correction can go either way (it compensates whatever was wrong), which is exactly why it is NOT a grant kind:
    // treating it as one would let a correction mint credits.
    expect(isCreditGrantKind('grant')).toBe(true);
    expect(isCreditGrantKind('release')).toBe(true);
    for (const k of ['reservation', 'consumption', 'correction']) expect(isCreditGrantKind(k)).toBe(false);
  });
});

describe('signedAmount — the sign convention IS the arithmetic', () => {
  test('grants and releases are positive; reservations and consumptions are negative', () => {
    // Signed amounts mean the balance is SUM(amount), full stop. If the sign lived in the reader instead, every future
    // caller would have to remember the rule, and one that forgot would compute a plausible wrong number.
    expect(signedAmount('grant', 10)).toBe(10);
    expect(signedAmount('release', 1)).toBe(1);
    expect(signedAmount('reservation', 1)).toBe(-1);
    expect(signedAmount('consumption', 1)).toBe(-1);
  });

  test('a correction carries its own sign, because it compensates in either direction', () => {
    expect(signedAmount('correction', 5)).toBe(5);
    expect(signedAmount('correction', -5)).toBe(-5);
  });

  test('a NEGATIVE magnitude on a non-correction is refused, not silently flipped', () => {
    // A negative grant is a spend wearing a grant's name. Coercing it would hide a caller bug inside the balance.
    for (const k of ['grant', 'release', 'reservation', 'consumption']) {
      expect(() => signedAmount(k, -1)).toThrow();
    }
  });

  test('a non-finite or non-integer amount is refused — credits are whole units', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, '1' as unknown as number, null as unknown as number]) {
      expect(() => signedAmount('grant', bad)).toThrow();
    }
  });

  test('an unrecognised KIND throws rather than defaulting to a sign', () => {
    // Defaulting either way is a guess about money. Both guesses are wrong: positive mints, negative burns.
    expect(() => signedAmount('bonus', 1)).toThrow();
  });
});

describe('canAfford', () => {
  test('exactly enough IS enough; one short is not', () => {
    expect(canAfford(1, 1)).toBe(true);
    expect(canAfford(0, 1)).toBe(false);
    expect(canAfford(5, 1)).toBe(true);
  });

  test('a negative balance affords nothing, and a nonsense balance affords nothing either', () => {
    // A negative balance should be impossible, but if the ledger ever produced one, the safe reading is "no credit",
    // never "the comparison happens to pass".
    expect(canAfford(-1, 1)).toBe(false);
    for (const bad of [Number.NaN, undefined, null, '5']) expect(canAfford(bad as number, 1)).toBe(false);
  });

  test('a zero or nonsense COST is refused rather than treated as free', () => {
    for (const bad of [0, -1, Number.NaN, undefined]) expect(canAfford(10, bad as number)).toBe(false);
  });
});

describe('decideRunSettlement — the charging rules (USAGE-AND-BILLING §4)', () => {
  test('a completed run CONSUMES', () => {
    expect(decideRunSettlement('succeeded')).toEqual({ kind: 'consume' });
  });

  test('EVERY failure releases — canon lists no failure that charges the customer', () => {
    // §4: "Failed call, provider fault | ... not billable; credit reservation released" and "Failed call, invalid
    // output after re-asks | ... credit released; counts against quality metrics, not the customer". There is no
    // fourth row that consumes, which is WHY the function takes no failure category: an argument that never changes
    // the answer would read as though it did. This test is where a future distinction has to show up first.
    expect(decideRunSettlement('failed')).toEqual({ kind: 'release' });
    expect(decideRunSettlement.length).toBe(1);
  });

  test('CANCELLED releases — MVP-generous, and canon says so explicitly', () => {
    // §4: "Cancelled mid-run | Metered to stop point; credit released (MVP-generous; revisit with D-02)". The
    // technical usage is still recorded; it is the CREDIT that is released.
    expect(decideRunSettlement('cancelled')).toEqual({ kind: 'release' });
  });

  test('a run still RUNNING settles nothing — the reservation stays held', () => {
    // Settling early would either charge for unfinished work or free a run that is still spending.
    expect(decideRunSettlement('running')).toEqual({ kind: 'hold' });
    expect(decideRunSettlement('queued')).toEqual({ kind: 'hold' });
  });

  test('an UNRECOGNISED outcome HOLDS — it never guesses at consuming or releasing', () => {
    // Fail closed in the direction that changes nothing: holding is reversible by a later settlement, whereas a wrong
    // consume charges someone and a wrong release gives work away.
    for (const bad of ['done', '', null, undefined, 7]) expect(decideRunSettlement(bad)).toEqual({ kind: 'hold' });
  });
});

describe('the MVP pricing rule', () => {
  test('is ONE credit per manual run, and it is a constant — not a schema assumption (D-02 open)', () => {
    // USAGE-AND-BILLING §1: the ledger must support task-credits, usage-billing or a hybrid "without schema change".
    // Keeping the rule in code is what makes that true; a DEFAULT or a CHECK would have to be migrated away.
    expect(CREDITS_PER_MANUAL_RUN).toBe(1);
  });
});
