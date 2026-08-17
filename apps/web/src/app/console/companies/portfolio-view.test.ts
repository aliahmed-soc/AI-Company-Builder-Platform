// ACBP-FE-004 — the portfolio view mapping, which is where this slice's real work lives.
//
// The page component is a thin renderer; EVERY decision worth testing is in `toPortfolioView`. In particular
// the six refusals are the centrepiece of the ticket, not an afterthought, so they are asserted individually
// AND pairwise-distinctly: a mapping that collapsed two refusals into the same words would still satisfy six
// separate assertions, and would still be a lie to whoever is looking at the screen.
import { describe, it, expect } from 'vitest';
import type { CompaniesRequestResult } from '@/server/companies/companies-request';
import { toPortfolioView, REFUSAL_CODES } from './portfolio-view';

/** A portfolio row exactly as `PortfolioItem` defines it — the five approved fields, nothing more. */
function row(over: Partial<{ companyId: string; name: string; status: string; role: string; createdAt: string }> = {}) {
  return {
    companyId: 'c_1',
    name: 'Northwind Coffee',
    status: 'active',
    role: 'owner',
    createdAt: '2026-08-01T09:00:00.000000Z',
    ...over,
  };
}

function portfolio(items: ReturnType<typeof row>[], nextCursor: string | null = null): CompaniesRequestResult {
  return { status: 'portfolio', page: { items, nextCursor } };
}

describe('toPortfolioView — companies', () => {
  it('maps the five portfolio fields and invents nothing else', () => {
    const view = toPortfolioView(portfolio([row()]));
    if (view.kind !== 'companies') throw new Error(`expected companies, got ${view.kind}`);

    expect(view.items).toHaveLength(1);
    const card = view.items[0]!;
    expect(card.companyId).toBe('c_1');
    expect(card.name).toBe('Northwind Coffee');
    expect(card.status).toBe('active');
    expect(card.role).toBe('owner');
    expect(card.createdAt).toBe('2026-08-01T09:00:00.000000Z');

    // THE WHOLE CARD, so a future field cannot be added without this test noticing. The portfolio read
    // returns no totals, no metrics and no account id (CDR-017 §9), and the card must not imply otherwise.
    expect(Object.keys(card).sort()).toEqual(['companyId', 'createdAt', 'name', 'role', 'status', 'statusTone'].sort());
  });

  it('renders the server status VERBATIM and never substitutes a label of its own', () => {
    // The portfolio row carries the truthful lifecycle status and NO `displayStatus` (unlike CompanyView).
    // Inventing a display mapping here would risk disagreeing with the detail read for the same company, so
    // the tone is decoration and the words are the server's.
    for (const status of ['draft', 'onboarding', 'active', 'paused', 'deactivating', 'something_new']) {
      const view = toPortfolioView(portfolio([row({ status })]));
      if (view.kind !== 'companies') throw new Error('expected companies');
      expect(view.items[0]!.status).toBe(status);
    }
  });

  it('assigns a tone per status, and an explicit unknown tone for a value it does not recognise', () => {
    const tone = (status: string) => {
      const v = toPortfolioView(portfolio([row({ status })]));
      if (v.kind !== 'companies') throw new Error('expected companies');
      return v.items[0]!.statusTone;
    };
    expect(tone('active')).toBe('active');
    expect(tone('paused')).toBe('paused');
    expect(tone('draft')).toBe('progress');
    expect(tone('onboarding')).toBe('progress');
    // A status the contract's comment does not list must NOT be silently styled as if it were understood.
    expect(tone('deactivating')).toBe('unknown');
    expect(tone('')).toBe('unknown');
  });

  it('reports whether the server said there is another page, without paging yet', () => {
    const more = toPortfolioView(portfolio([row()], 'cursor_abc'));
    if (more.kind !== 'companies') throw new Error('expected companies');
    expect(more.hasMore).toBe(true);

    const done = toPortfolioView(portfolio([row()], null));
    if (done.kind !== 'companies') throw new Error('expected companies');
    expect(done.hasMore).toBe(false);
  });

  it('treats an empty page as EMPTY, never as a refusal', () => {
    // `restricted` is never the same as empty. A zero-row portfolio means the founder has no companies;
    // it does not mean anything was withheld, and must not borrow refusal wording.
    const view = toPortfolioView(portfolio([]));
    expect(view.kind).toBe('empty');
  });
});

describe('toPortfolioView — the six refusals', () => {
  const cases: ReadonlyArray<{ result: CompaniesRequestResult; code: string }> = [
    { result: { status: 'unauthenticated' }, code: 'unauthenticated' },
    { result: { status: 'email_unverified' }, code: 'email_unverified' },
    { result: { status: 'rate_limited', retryAfterSeconds: 47 }, code: 'rate_limited' },
    { result: { status: 'unavailable' }, code: 'unavailable' },
    { result: { status: 'forbidden' }, code: 'forbidden' },
    { result: { status: 'not_found' }, code: 'not_found' },
  ];

  it('covers exactly the refusals the portfolio read can actually return', () => {
    expect([...REFUSAL_CODES].sort()).toEqual(cases.map((c) => c.code).sort());
  });

  for (const { result, code } of cases) {
    it(`maps ${code} to its own refusal with a title and an explanation`, () => {
      const view = toPortfolioView(result);
      if (view.kind !== 'refusal') throw new Error(`expected refusal for ${code}, got ${view.kind}`);
      expect(view.refusal.code).toBe(code);
      expect(view.refusal.title.length).toBeGreaterThan(0);
      expect(view.refusal.detail.length).toBeGreaterThan(0);
    });
  }

  it('gives every refusal DISTINCT words — no two share a title or an explanation', () => {
    const views = cases.map(({ result }) => {
      const v = toPortfolioView(result);
      if (v.kind !== 'refusal') throw new Error('expected refusal');
      return v.refusal;
    });
    expect(new Set(views.map((r) => r.title)).size).toBe(cases.length);
    expect(new Set(views.map((r) => r.detail)).size).toBe(cases.length);
  });

  it('surfaces the ACTUAL retryAfterSeconds it was given, not a hardcoded number', () => {
    for (const seconds of [1, 47, 3600]) {
      const view = toPortfolioView({ status: 'rate_limited', retryAfterSeconds: seconds });
      if (view.kind !== 'refusal' || view.refusal.code !== 'rate_limited') throw new Error('expected rate_limited');
      expect(view.refusal.retryAfterSeconds).toBe(seconds);
      expect(view.refusal.detail).toContain(String(seconds));
    }
  });

  it('does NOT claim a company exists or does not exist — forbidden and not_found describe the ACCOUNT', () => {
    // At the collection level these two mean "your user record is deleted" and "you have no internal user
    // record", resolved before any company is touched (companies-request.ts resolveActor). Neither may be
    // worded as though it disclosed the existence of some company.
    for (const status of ['forbidden', 'not_found'] as const) {
      const view = toPortfolioView({ status });
      if (view.kind !== 'refusal') throw new Error('expected refusal');
      const words = `${view.refusal.title} ${view.refusal.detail}`.toLowerCase();
      expect(words).not.toContain('this company');
      expect(words).not.toContain('that company');
    }
  });
});

describe('toPortfolioView — anything else', () => {
  it('falls back to an honest unexpected state rather than throwing or rendering blank', () => {
    // `CompaniesRequestResult` is shared by every company request, so it carries statuses this read cannot
    // produce. If the server ever returns one, the page must say so instead of crashing or showing nothing.
    const view = toPortfolioView({ status: 'conflict' });
    if (view.kind !== 'refusal') throw new Error('expected refusal');
    expect(view.refusal.code).toBe('unexpected');
    expect(view.refusal.detail).toContain('conflict');
  });

  it('does not throw for any status in the shared union', () => {
    const statuses = ['validation', 'invalid_transition', 'conflict', 'invalid_cursor', 'invalid_limit', 'created', 'company', 'renamed', 'transitioned', 'activity', 'company_not_active'];
    for (const status of statuses) {
      expect(() => toPortfolioView({ status } as CompaniesRequestResult)).not.toThrow();
    }
  });
});
