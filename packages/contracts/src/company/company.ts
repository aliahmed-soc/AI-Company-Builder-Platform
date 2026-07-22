// @acbp/contracts — provider-neutral company lifecycle contracts (ACBP-P1-010; CDR-015; COMP-001/004/005/006/008;
// WORKFLOW-STATE-MACHINES §1). Transport- and provider-neutral; zero-dependency like the rest of @acbp/contracts.
//
// Scope note (CDR-015): P1-010 implements the `draft → onboarding → active ⇄ paused` subset. `deactivating` /
// `deactivated` / `deleted` are DEFERRED (owner decision) and are intentionally NOT part of the P1-010 status set,
// so the database CHECK stays tight to what is reachable; they expand in a later ticket.

/** Company lifecycle statuses reachable in ACBP-P1-010. */
export type CompanyStatus = 'draft' | 'onboarding' | 'active' | 'paused';
export const COMPANY_STATUSES: readonly CompanyStatus[] = ['draft', 'onboarding', 'active', 'paused'];
export function isCompanyStatus(value: unknown): value is CompanyStatus {
  return typeof value === 'string' && (COMPANY_STATUSES as readonly string[]).includes(value);
}

/**
 * Human-readable operating status (COMP-008). Maps the raw lifecycle state to a display value. An unrecognized
 * state renders as `'unknown'` — NEVER a fabricated healthy state (COMP-008 "Unknown states render as 'unknown'").
 * This takes an unknown string on purpose: it is the honest projection at the read boundary.
 */
export type CompanyDisplayStatus = 'provisioning' | 'active' | 'paused' | 'unknown';
export function toDisplayStatus(status: unknown): CompanyDisplayStatus {
  switch (status) {
    case 'draft':
    case 'onboarding':
      return 'provisioning';
    case 'active':
      return 'active';
    case 'paused':
      return 'paused';
    default:
      return 'unknown';
  }
}

/**
 * Company creation modes (COMP-001): the caller starts a company from (a) their own idea, (b) a platform-suggested
 * idea, or (c) an existing business description. Closed set; anything else is rejected. `own_idea` is the fully
 * functional MVP mode ("idea-mode full"). The mode is onboarding INPUT — it does not affect company cardinality.
 */
export type CompanyCreationMode = 'own_idea' | 'platform_suggested' | 'existing_business';
export const COMPANY_CREATION_MODES: readonly CompanyCreationMode[] = ['own_idea', 'platform_suggested', 'existing_business'];
export function isCompanyCreationMode(value: unknown): value is CompanyCreationMode {
  return typeof value === 'string' && (COMPANY_CREATION_MODES as readonly string[]).includes(value);
}

/** The initial lifecycle status a newly-created company is minted with (server-selected, not caller-supplied). */
export const INITIAL_COMPANY_STATUS: CompanyStatus = 'draft';

/**
 * Server-enforced legal company lifecycle transitions for ACBP-P1-010 (WORKFLOW §1 subset). `draft→onboarding`
 * and `onboarding→active` are system-driven; `active⇄paused` are owner-driven. An unlisted (from,to) pair is an
 * illegal transition and must be rejected + audited. Deactivate/delete are deferred (absent here).
 */
const LEGAL_TRANSITIONS: Readonly<Record<CompanyStatus, readonly CompanyStatus[]>> = {
  draft: ['onboarding'],
  onboarding: ['active'],
  active: ['paused'],
  paused: ['active'],
};
export function isLegalCompanyTransition(from: CompanyStatus, to: CompanyStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/**
 * COMP-006 / WORKFLOW §1 invariant 16 (groundwork): only an ACTIVE company may pick up NEW autonomous work.
 * A paused company (and a not-yet-active draft/onboarding company) blocks new job pickup — this pure predicate
 * is the single truth a scheduler/worker consults before opening a run. In-flight safe-stop is a separate
 * concern; this governs NEW pickup only. Pausing is the enforcement point (P1-010); the scheduler is later.
 */
export function canPickUpAutonomousWork(status: CompanyStatus): boolean {
  return status === 'active';
}
