/*
 * ACBP-FE-004 — mapping the portfolio read into something a screen can render.
 *
 * This module is the slice's real logic and is deliberately PURE: it takes the discriminated result the server
 * produced and returns a discriminated view. No fetching, no session, no React — so every state, including the
 * ones that are awkward to reach in a browser, is reachable in a unit test.
 *
 * TWO RULES SHAPE EVERYTHING HERE.
 *
 * 1. THE CARD SHOWS ONLY WHAT THE PORTFOLIO READ RETURNS. `PortfolioItem` is exactly five fields —
 *    `companyId`, `name`, `status`, `role`, `createdAt` — and the contract says it "Exposes NOTHING beyond the
 *    five approved fields (CDR-017 §9)": no totals, no metrics, no account id. A card showing a task count or a
 *    credit figure would be inventing a read this slice does not make, so it shows those five and nothing else.
 *
 * 2. A REFUSAL IS NOT AN EMPTY LIST. The server distinguishes "you may not see this" from "there is nothing
 *    here", and collapsing the two would tell a paying founder their own company does not exist. Each refusal
 *    therefore gets its own words, asserted pairwise-distinct in the test beside this file.
 */
import type { CompaniesRequestResult } from '@/server/companies/companies-request';

/** Presentation tone only. It NEVER replaces the status word the server sent — see `toCard`. */
export type StatusTone = 'active' | 'paused' | 'progress' | 'unknown';

/** One company, as the portfolio read describes it. Five server fields plus a tone for styling. */
export interface PortfolioCard {
  readonly companyId: string;
  readonly name: string;
  /** The server's TRUTHFUL lifecycle status, rendered verbatim. */
  readonly status: string;
  readonly statusTone: StatusTone;
  /** The CALLER's role in this company, from their own active membership. */
  readonly role: string;
  readonly createdAt: string;
}

/**
 * The refusals `getPortfolioForRequest` can actually produce. Deliberately NOT every status in
 * `CompaniesRequestResult` — that union is shared by every company request, and listing statuses this read
 * cannot return would invite handling for cases that never arrive while hiding the ones that do.
 */
export const REFUSAL_CODES = ['unauthenticated', 'email_unverified', 'rate_limited', 'unavailable', 'forbidden', 'not_found'] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number] | 'unexpected';

export interface PortfolioRefusal {
  readonly code: RefusalCode;
  readonly title: string;
  readonly detail: string;
  /** Present only for `rate_limited`: the ACTUAL seconds the server asked us to wait. */
  readonly retryAfterSeconds?: number;
}

export type PortfolioView =
  | { readonly kind: 'companies'; readonly items: readonly PortfolioCard[]; readonly hasMore: boolean }
  | { readonly kind: 'empty' }
  | { readonly kind: 'refusal'; readonly refusal: PortfolioRefusal };

/*
 * The status word is the server's; the tone is ours. `PortfolioItem.status` is typed `string` and its comment
 * lists four values ('draft' | 'onboarding' | 'active' | 'paused') — a comment, not a union, so a fifth value
 * can arrive. Anything unlisted gets the `unknown` tone rather than being styled as though it were understood.
 *
 * WHY NO DISPLAY MAPPING: the detail read (`CompanyView`) ships BOTH `status` and `displayStatus`, and its
 * `displayStatus` is the value meant for founders. The portfolio row ships no such field. Inventing one here
 * would risk this screen and the company screen disagreeing about the same company, so the word is passed
 * through untouched and the choice is left to whoever owns that decision.
 */
function toneFor(status: string): StatusTone {
  switch (status) {
    case 'active':
      return 'active';
    case 'paused':
      return 'paused';
    case 'draft':
    case 'onboarding':
      return 'progress';
    default:
      return 'unknown';
  }
}

function toCard(item: { companyId: string; name: string; status: string; role: string; createdAt: string }): PortfolioCard {
  return {
    companyId: item.companyId,
    name: item.name,
    status: item.status,
    statusTone: toneFor(item.status),
    role: item.role,
    createdAt: item.createdAt,
  };
}

/*
 * THE REFUSAL COPY LIVES HERE, NOT IN THE COMPONENT, so the words themselves are unit-tested. Two constraints
 * the test enforces:
 *
 *   - Every title and every detail is distinct. Six branches that render three messages would pass six
 *     individual assertions and still be dishonest on screen.
 *   - `forbidden` and `not_found` say nothing about any company. At the COLLECTION level they are resolved
 *     before a company is ever touched (`resolveActor` in companies-request.ts): `forbidden` means the internal
 *     user record is DELETED, `not_found` means there is no internal user record for this sign-in. The
 *     deliberate forbidden/not-found ambiguity documented for company-scoped routes is about a different
 *     question — whether some named company exists — and does not apply to this read.
 */
function refusalFor(result: CompaniesRequestResult): PortfolioRefusal {
  switch (result.status) {
    case 'unauthenticated':
      return {
        code: 'unauthenticated',
        title: 'You are signed out',
        detail: 'This page reads the companies you belong to, which requires a verified session. Sign in and it will load.',
      };
    case 'email_unverified':
      return {
        code: 'email_unverified',
        title: 'Your email address is not verified',
        detail: 'You are signed in, but the platform requires a verified primary email before it reads any company data. Verify the address on your account, then reload.',
      };
    case 'rate_limited':
      return {
        code: 'rate_limited',
        title: 'Too many requests',
        detail: `A request ceiling refused this read. It should succeed again in about ${result.retryAfterSeconds} seconds.`,
        retryAfterSeconds: result.retryAfterSeconds,
      };
    case 'unavailable':
      return {
        code: 'unavailable',
        title: 'Something this page depends on is down',
        detail: 'The read could not complete because a dependency is unavailable. Nothing is wrong with your account and retrying is safe.',
      };
    case 'forbidden':
      return {
        code: 'forbidden',
        title: 'This sign-in is no longer active on the platform',
        detail: 'The user record behind this sign-in has been deleted, so no portfolio can be read for it. An operator has to restore or recreate the record; nothing you can do on this screen will change it.',
      };
    case 'not_found':
      return {
        code: 'not_found',
        title: 'This sign-in has no platform user record yet',
        detail: 'You are authenticated with the identity provider, but no internal user has been created for you — usually a provisioning step that has not landed. Reloading in a moment often resolves it.',
      };
    default:
      return {
        code: 'unexpected',
        title: 'Unexpected response',
        detail: `The server answered with a status this screen does not handle: ${result.status}. Nothing has been shown rather than guessing at what it meant.`,
      };
  }
}

/** Map the portfolio read into the view the page renders. Total: every input yields a renderable state. */
export function toPortfolioView(result: CompaniesRequestResult): PortfolioView {
  if (result.status === 'portfolio') {
    const items = result.page.items.map(toCard);
    // An empty page is EMPTY, never a refusal: the founder has no companies, and nothing was withheld.
    if (items.length === 0) return { kind: 'empty' };
    return { kind: 'companies', items, hasMore: result.page.nextCursor !== null && result.page.nextCursor !== undefined };
  }
  return { kind: 'refusal', refusal: refusalFor(result) };
}
