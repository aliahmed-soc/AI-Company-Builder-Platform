/*
 * ACBP-FE-006 — mapping the company detail read into a renderable view, including whether the pause/resume
 * control is available and, when it is not, WHY.
 *
 * WHY THE REASON MATTERS ENOUGH TO COMPUTE. An unauthorized transition comes back from the server as a bare
 * `forbidden`, deliberately indistinguishable from "no such company". So the reason a viewer cannot pause is
 * NOT recoverable after a failed attempt — it has to be known before the control renders. That is the whole
 * argument for `CompanyView.role` existing, and this module is where it is spent.
 *
 * THIS IS PRESENTATION, NOT ENFORCEMENT. `company:pause` and `company:resume` are owner-only in the authz
 * matrix and checked inside @acbp/core on every call. A disabled button here changes nothing about what the
 * server will accept; it only stops the interface implying an action that would be refused (AGENTS.md §18).
 */
import type { CompaniesRequestResult } from '@/server/companies/companies-request';

export type TransitionAction = 'pause' | 'resume';

export type ControlState =
  | { readonly kind: 'available'; readonly action: TransitionAction; readonly label: string }
  /** `because` separates the two reasons so the UI cannot collapse them into one shrug. */
  | { readonly kind: 'unavailable'; readonly because: 'role' | 'lifecycle'; readonly reason: string };

export interface CompanyCard {
  readonly companyId: string;
  /** The founder-facing status (COMP-008): an unrecognised state renders `unknown`, never a fake healthy one. */
  readonly displayStatus: string;
  /** The raw lifecycle value. Shown as secondary detail — it is what the transition rules are written against. */
  readonly internalStatus: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly profileVersion: number | null;
  readonly role: string;
}

export interface CompanyRefusal {
  readonly code: string;
  readonly title: string;
  readonly detail: string;
}

export type CompanyPageView =
  | { readonly kind: 'company'; readonly company: CompanyCard; readonly control: ControlState }
  | { readonly kind: 'refusal'; readonly refusal: CompanyRefusal };

/*
 * The transition rules, mirrored from core rather than guessed: pause requires the company to be exactly
 * `active`, resume requires exactly `paused`. Every other lifecycle value — including one this build has never
 * heard of — has no legal transition, and is reported as such instead of being offered a button that would
 * 409 with `invalid_transition`.
 */
function actionFor(internalStatus: string): TransitionAction | null {
  if (internalStatus === 'active') return 'pause';
  if (internalStatus === 'paused') return 'resume';
  return null;
}

function controlFor(card: CompanyCard): ControlState {
  const action = actionFor(card.internalStatus);

  /*
   * ROLE IS REPORTED FIRST when both reasons apply. A viewer looking at a draft company is blocked by BOTH,
   * but telling them only about the lifecycle would imply they could act once provisioning finished — which
   * is false, and is the kind of almost-true interface this console exists to avoid.
   */
  if (card.role !== 'owner') {
    return {
      kind: 'unavailable',
      because: 'role',
      reason: 'Pausing and resuming a company is restricted to an owner. Your membership here is a viewer, so the server would refuse this even if the button were active.',
    };
  }

  if (action === null) {
    return {
      kind: 'unavailable',
      because: 'lifecycle',
      reason: `A company can only be paused while it is active, or resumed while it is paused. This one is ${card.displayStatus}, so neither transition applies right now.`,
    };
  }

  return {
    kind: 'available',
    action,
    label: action === 'pause' ? 'Pause this company' : 'Resume this company',
  };
}

/*
 * REFUSAL COPY IS DELIBERATELY DIFFERENT FROM THE PORTFOLIO'S, and this is the subtle part.
 *
 * On the COLLECTION read, `forbidden` and `not_found` are resolved before any company is touched, so the
 * portfolio can say precisely what they mean. On THIS read each is reachable from two causes — the same
 * identity-level ones, plus a company-level refusal where `forbidden` is deliberately indistinguishable from
 * "no such company". The page cannot tell which occurred, so the words must be TRUE UNDER EITHER cause.
 * Naming one would be inventing information, and claiming the company does not exist would leak an answer the
 * server refuses to give.
 */
function refusalFor(result: CompaniesRequestResult): CompanyRefusal {
  switch (result.status) {
    case 'unauthenticated':
      return { code: 'unauthenticated', title: 'You are signed out', detail: 'Opening a company requires a verified session. Sign in and this page will load.' };
    case 'email_unverified':
      return { code: 'email_unverified', title: 'Your email address is not verified', detail: 'The platform requires a verified primary email before it reads company data. Verify the address on your account, then reload.' };
    case 'rate_limited':
      return { code: 'rate_limited', title: 'Too many requests', detail: `A request ceiling refused this read. It should succeed again in about ${result.retryAfterSeconds} seconds.` };
    case 'unavailable':
      return { code: 'unavailable', title: 'Something this page depends on is down', detail: 'The read could not complete because a dependency is unavailable. Retrying is safe.' };
    case 'forbidden':
      return {
        code: 'forbidden',
        title: 'This company is not available to you',
        detail: 'The server declined to open it and does not say whether that is because no such company is reachable from your account, or because your access to it has been withdrawn — the two are answered identically on purpose, so this page cannot tell you which. If you reached this from your portfolio, reload that list.',
      };
    case 'not_found':
      return {
        code: 'not_found',
        title: 'Nothing was found for this address',
        detail: 'Either the company record or the platform record for your sign-in could not be resolved. If you arrived from your portfolio, the company may have been removed since that list loaded; if you have just signed up, your account may still be provisioning.',
      };
    default:
      return { code: 'unexpected', title: 'Unexpected response', detail: `The server answered with a status this screen does not handle: ${result.status}. Nothing has been shown rather than guessing at what it meant.` };
  }
}

export function toCompanyPageView(result: CompaniesRequestResult): CompanyPageView {
  if (result.status !== 'company') return { kind: 'refusal', refusal: refusalFor(result) };
  const c = result.company;
  const card: CompanyCard = {
    companyId: c.companyId,
    displayStatus: c.displayStatus,
    internalStatus: c.status,
    name: c.name,
    description: c.description,
    profileVersion: c.profileVersion,
    role: c.role,
  };
  return { kind: 'company', company: card, control: controlFor(card) };
}
