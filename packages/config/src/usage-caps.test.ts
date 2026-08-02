// @acbp/config — CDR-008's interim usage caps (ACBP-P6-010; CDR-075 §4).
import { describe, expect, it } from 'vitest';
import { parseUsageCapsConfig, USAGE_CAP_DEFAULTS } from './usage-caps.js';
import { ConfigValidationError } from './index.js';

describe('parseUsageCapsConfig', () => {
  it('defaults to CDR-008 §8 exactly, in integer micro-units', () => {
    // These are the OWNER'S numbers (CDR-008, Accepted, interim, revisit-bound at first alpha telemetry). This
    // test is where they are pinned: if someone edits the constants, this fails and they have to say why.
    // $5/day and $50/month per company, account ceiling 3x, soft alert at 75%.
    const c = parseUsageCapsConfig({});
    expect(c.companyDailyMicros).toBe(5_000_000);
    expect(c.companyMonthlyMicros).toBe(50_000_000);
    expect(c.accountMultiplier).toBe(3);
    expect(c.softPercent).toBe(75);
    expect(c).toEqual(USAGE_CAP_DEFAULTS);
  });

  it('lets every value be overridden, because CDR-008 §26 rates the reversal cost as pure configuration', () => {
    const c = parseUsageCapsConfig({
      ACBP_CAP_COMPANY_DAILY_MICROS: '1234',
      ACBP_CAP_COMPANY_MONTHLY_MICROS: '99999',
      ACBP_CAP_ACCOUNT_MULTIPLIER: '5',
      ACBP_CAP_SOFT_PERCENT: '90',
    });
    expect(c).toEqual({ companyDailyMicros: 1234, companyMonthlyMicros: 99_999, accountMultiplier: 5, softPercent: 90 });
  });

  it('REFUSES a malformed value rather than falling back to the default', () => {
    // THE GUARD THAT MATTERS MOST HERE. A typo'd cap that silently becomes the default is a cap the owner
    // believes they changed and did not — they would see the platform enforcing $5/day while their config says
    // $500/day, and the config file would look right. Fail fast, loudly, at the boundary.
    for (const bad of ['', ' ', 'abc', '5.5', '-1', '1e6', '0x10']) {
      expect(() => parseUsageCapsConfig({ ACBP_CAP_COMPANY_DAILY_MICROS: bad })).toThrow(ConfigValidationError);
    }
  });

  it('refuses a soft percentage that is not a live threshold', () => {
    // 0 would alert on every call from zero spend; 100 would alert only at the moment the hard cap already
    // blocks, which is an alert that can never be acted on in time. Both are configuration mistakes, not
    // preferences, and `evaluateCaps` would halt on them at runtime — better to refuse at load.
    for (const bad of ['0', '100', '101', '-5']) {
      expect(() => parseUsageCapsConfig({ ACBP_CAP_SOFT_PERCENT: bad })).toThrow(ConfigValidationError);
    }
    expect(parseUsageCapsConfig({ ACBP_CAP_SOFT_PERCENT: '1' }).softPercent).toBe(1);
    expect(parseUsageCapsConfig({ ACBP_CAP_SOFT_PERCENT: '99' }).softPercent).toBe(99);
  });

  it('permits a zero cap — "no spend allowed" is a real setting, not a mistake', () => {
    // Distinct from an ABSENT cap, which means unrestricted (CDR-075 §2-G2.4). Refusing 0 here would remove the
    // owner's ability to freeze spend without deleting the cap entirely.
    expect(parseUsageCapsConfig({ ACBP_CAP_COMPANY_DAILY_MICROS: '0' }).companyDailyMicros).toBe(0);
  });

  it('refuses an account multiplier below 1', () => {
    // The account ceiling exists to bound the SUM across a founder's companies. Below 1 it would sit under a
    // single company's own cap, so the company cap could never be reached and the per-company value would be
    // decoration.
    for (const bad of ['0', '-1', '0.5']) {
      expect(() => parseUsageCapsConfig({ ACBP_CAP_ACCOUNT_MULTIPLIER: bad })).toThrow(ConfigValidationError);
    }
  });

  it('never lets a validation error echo the offending value', () => {
    // House rule for this package: errors name the FIELD, never the content. A cap is not a secret, but the
    // rule is uniform so no future field has to remember to opt in.
    try {
      parseUsageCapsConfig({ ACBP_CAP_COMPANY_DAILY_MICROS: 'sensitive-looking-garbage' });
      throw new Error('expected a throw');
    } catch (e) {
      expect(String(e)).not.toContain('sensitive-looking-garbage');
      expect(String(e)).toContain('ACBP_CAP_COMPANY_DAILY_MICROS');
    }
  });
});
