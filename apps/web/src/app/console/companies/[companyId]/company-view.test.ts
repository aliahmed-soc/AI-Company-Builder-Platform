// ACBP-FE-006 — the company profile mapping.
//
// Two things make this different from the portfolio mapping and both are asserted here.
//
// 1. THE CONTROL HAS THREE OUTCOMES, NOT TWO. Pause/resume can be unavailable because the caller is a VIEWER
//    (owner-only) or because the company's lifecycle state has no legal transition — and those are different
//    sentences to a founder. A single "unavailable" would be a shrug.
// 2. THE REFUSAL COPY CANNOT BE BORROWED FROM THE PORTFOLIO. On this read `forbidden` and `not_found` are each
//    reachable from TWO causes (identity-level and company-level), and company-level `forbidden` is
//    deliberately indistinguishable from "no such company". Wording that named one cause would be a guess.
import { describe, it, expect } from 'vitest';
import type { CompaniesRequestResult } from '@/server/companies/companies-request';
import { toCompanyPageView } from './company-view';

function company(over: Partial<{ status: string; displayStatus: string; role: string; name: string | null }> = {}): CompaniesRequestResult {
  return {
    status: 'company',
    company: {
      companyId: 'cmp_1',
      status: 'active',
      displayStatus: 'active',
      name: 'Northwind Coffee',
      description: 'Speciality roasting.',
      profileVersion: 3,
      role: 'owner',
      ...over,
    },
  } as CompaniesRequestResult;
}

describe('toCompanyPageView — the company', () => {
  it('renders displayStatus, not the internal status', () => {
    // The detail read ships BOTH, and displayStatus is the founder-facing one (COMP-008). This is the screen
    // that finally has the field the portfolio row lacks.
    const view = toCompanyPageView(company({ status: 'onboarding', displayStatus: 'provisioning' }));
    if (view.kind !== 'company') throw new Error(`expected company, got ${view.kind}`);
    expect(view.company.displayStatus).toBe('provisioning');
    expect(view.company.internalStatus).toBe('onboarding');
  });

  it('keeps a missing name and description honest rather than inventing a placeholder', () => {
    const view = toCompanyPageView(company({ name: null }));
    if (view.kind !== 'company') throw new Error('expected company');
    expect(view.company.name).toBeNull();
  });
});

describe('toCompanyPageView — the pause/resume control', () => {
  const control = (over: Parameters<typeof company>[0]) => {
    const v = toCompanyPageView(company(over));
    if (v.kind !== 'company') throw new Error('expected company');
    return v.control;
  };

  it('offers PAUSE to an owner of an active company', () => {
    const c = control({ status: 'active', role: 'owner' });
    expect(c).toMatchObject({ kind: 'available', action: 'pause' });
  });

  it('offers RESUME to an owner of a paused company', () => {
    const c = control({ status: 'paused', displayStatus: 'paused', role: 'owner' });
    expect(c).toMatchObject({ kind: 'available', action: 'resume' });
  });

  it('refuses a VIEWER with a role reason, on a company that is otherwise transitionable', () => {
    // The company IS active, so the only thing stopping the transition is the caller's role. The reason must
    // say that, because the server's refusal would come back as a bare `forbidden` that says nothing.
    const c = control({ status: 'active', role: 'viewer' });
    expect(c.kind).toBe('unavailable');
    if (c.kind !== 'unavailable') throw new Error('expected unavailable');
    expect(c.because).toBe('role');
    expect(c.reason.toLowerCase()).toContain('owner');
  });

  it('refuses an OWNER on a lifecycle state with no legal transition, and names the state', () => {
    for (const [status, displayStatus] of [['draft', 'provisioning'], ['onboarding', 'provisioning'], ['deactivating', 'deactivating'], ['deactivated', 'deactivated']]) {
      const c = control({ status, displayStatus, role: 'owner' });
      expect(c.kind).toBe('unavailable');
      if (c.kind !== 'unavailable') throw new Error('expected unavailable');
      expect(c.because).toBe('lifecycle');
      // Naming the state is what makes it actionable rather than a shrug.
      expect(c.reason).toContain(displayStatus!);
    }
  });

  it('reports the ROLE reason first when a viewer also has no legal transition', () => {
    // Both are true; the role is the one the founder can do something about (ask an owner), and telling a
    // viewer only about the lifecycle would imply they could act once it changed.
    const c = control({ status: 'draft', displayStatus: 'provisioning', role: 'viewer' });
    if (c.kind !== 'unavailable') throw new Error('expected unavailable');
    expect(c.because).toBe('role');
  });

  it('treats an unrecognised lifecycle value as NOT transitionable rather than guessing', () => {
    const c = control({ status: 'something_new', displayStatus: 'unknown', role: 'owner' });
    expect(c.kind).toBe('unavailable');
  });
});

describe('toCompanyPageView — refusals', () => {
  it('gives every reachable refusal distinct words', () => {
    const codes = ['unauthenticated', 'email_unverified', 'unavailable', 'forbidden', 'not_found'] as const;
    const seen = codes.map((status) => {
      const v = toCompanyPageView({ status });
      if (v.kind !== 'refusal') throw new Error(`expected refusal for ${status}`);
      return v.refusal;
    });
    expect(new Set(seen.map((r) => r.title)).size).toBe(codes.length);
    expect(new Set(seen.map((r) => r.detail)).size).toBe(codes.length);
  });

  it('surfaces the actual retryAfterSeconds', () => {
    const v = toCompanyPageView({ status: 'rate_limited', retryAfterSeconds: 12 });
    if (v.kind !== 'refusal') throw new Error('expected refusal');
    expect(v.refusal.detail).toContain('12');
  });

  it('does NOT claim whether the company exists, because the server refuses to say', () => {
    // Company-level `forbidden` is deliberately indistinguishable from "no such company", and BOTH forbidden
    // and not_found are also reachable from identity-level causes on this same read. Copy that picked one
    // cause would be inventing information the page does not have.
    for (const status of ['forbidden', 'not_found'] as const) {
      const v = toCompanyPageView({ status });
      if (v.kind !== 'refusal') throw new Error('expected refusal');
      const words = `${v.refusal.title} ${v.refusal.detail}`.toLowerCase();
      expect(words).not.toContain('does not exist');
      expect(words).not.toContain('deleted company');
    }
  });

  it('falls back honestly for a status this read cannot produce', () => {
    const v = toCompanyPageView({ status: 'conflict' });
    if (v.kind !== 'refusal') throw new Error('expected refusal');
    expect(v.refusal.code).toBe('unexpected');
    expect(v.refusal.detail).toContain('conflict');
  });
});
