// @acbp/contracts — provider-neutral company lifecycle contracts (ACBP-P1-010; CDR-015; COMP-001/004/005/006/008;
// WORKFLOW-STATE-MACHINES §1). Transport- and provider-neutral; zero-dependency like the rest of @acbp/contracts.
//
// Scope note: P1-010 implemented the `draft → onboarding → active ⇄ paused` subset and deferred the rest.
// ACBP-P7-002 (CDR-079) adds the two DEACTIVATION phases — that is the "later ticket" the P1-010 note promised.
//
// `deleted` REMAINS ABSENT, deliberately (CDR-079 §3-G6). COMP-007/ACC-005 own deletion and are out of scope;
// canon makes three DIFFERENT reachability claims for `deleted` (`WORKFLOW §1:9` "via COMP-007 only", `:19`
// "any→deleted", `diagrams/15` reachable only from deactivation), so its transition set cannot be written down
// without picking a winner; and the autonomous-work gate is an ALLOWLIST over `unknown`, so it refuses `deleted`
// correctly WITHOUT a vocabulary entry. The database CHECK stays tight to what is reachable — migration
// `0008_companies.ts:53`'s precedent.

/** Company lifecycle statuses (WORKFLOW §1; `deleted` deliberately excluded — see the scope note above). */
export type CompanyStatus = 'draft' | 'onboarding' | 'active' | 'paused' | 'deactivating' | 'deactivated';
export const COMPANY_STATUSES: readonly CompanyStatus[] = ['draft', 'onboarding', 'active', 'paused', 'deactivating', 'deactivated'];
export function isCompanyStatus(value: unknown): value is CompanyStatus {
  return typeof value === 'string' && (COMPANY_STATUSES as readonly string[]).includes(value);
}

/**
 * Human-readable operating status (COMP-008). Maps the raw lifecycle state to a display value. An unrecognized
 * state renders as `'unknown'` — NEVER a fabricated healthy state (COMP-008 "Unknown states render as 'unknown'").
 * This takes an unknown string on purpose: it is the honest projection at the read boundary.
 */
export type CompanyDisplayStatus = 'provisioning' | 'active' | 'paused' | 'deactivating' | 'deactivated' | 'unknown';
export function toDisplayStatus(status: unknown): CompanyDisplayStatus {
  switch (status) {
    case 'draft':
    case 'onboarding':
      return 'provisioning';
    case 'active':
      return 'active';
    case 'paused':
      return 'paused';
    // THE TWO DEACTIVATION PHASES RENDER DISTINCTLY, and adding them here is not optional decoration: widening
    // `CompanyStatus` without widening this would leave a state the platform knows perfectly well rendering as
    // `'unknown'` on the exact screen a founder consults after deactivating — regressing COMP-008's "status
    // reflects actual lifecycle state" while the docstring above stayed intact and useless. They stay SEPARATE
    // because they mean different things to the reader (in progress vs finished) and because canon blocks work
    // at the first, not the second. ENFORCED BY: "EVERY status in the vocabulary has a display value".
    case 'deactivating':
      return 'deactivating';
    case 'deactivated':
      return 'deactivated';
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
 * Server-enforced legal company lifecycle transitions (WORKFLOW §1). `draft→onboarding` and `onboarding→active`
 * are system-driven; `active⇄paused` and the deactivation initiation are owner-driven; `deactivating→deactivated`
 * is system-driven. An unlisted (from,to) pair is illegal and must be rejected + audited.
 *
 * DEACTIVATION IS TWO-PHASE, AND BOTH `active` AND `paused` ARE LEGAL SOURCES. `WORKFLOW §1:17`'s source cell is
 * `active/paused`, so both edges exist; `diagrams/15` draws `pause -.-> deact` as the only inbound edge and
 * contradicts it — §1 wins, being the state-machine document rather than a data-lifecycle picture (CDR-079
 * records the divergence rather than editing either).
 *
 * THE INTERMEDIATE PHASE CANNOT BE SKIPPED (CDR-079 §3-G5): collapsing the two would make "work stopped" depend
 * on teardown succeeding, when canon binds work-blocking to ENTERING `deactivating` (`:17` Effects "autonomous
 * work blocked"), not to reaching `deactivated`.
 *
 * `deactivated` IS TERMINAL (⏹) and has NO outbound edge — including back to `active`. Four canon statements
 * nonetheless demand a documented reactivation path; those are reconciled by DOCUMENTING the real answer (an
 * owner decision, CDR-079 §9.7), never by inventing an edge canon forbids. A deactivation likewise cannot be
 * ABORTED: canon lists no reverse edge from `deactivating`, so "I clicked deactivate by mistake" has no answer
 * today and is escalated (§9.12) rather than answered by an engineer.
 */
const LEGAL_TRANSITIONS: Readonly<Record<CompanyStatus, readonly CompanyStatus[]>> = {
  draft: ['onboarding'],
  onboarding: ['active'],
  active: ['paused', 'deactivating'],
  paused: ['active', 'deactivating'],
  deactivating: ['deactivated'],
  deactivated: [],
};
export function isLegalCompanyTransition(from: CompanyStatus, to: CompanyStatus): boolean {
  // NO `?? []` FALLBACK, and that is a deliberate removal. One was written here to stop a status added to the
  // vocabulary without a transition list from THROWING on lookup — but mutation testing showed no test could
  // distinguish its presence from its absence, because `Readonly<Record<CompanyStatus, …>>` makes the missing
  // key a COMPILE error, so the branch is unreachable by construction. A guard nothing can reach reads as a
  // control and is not one (the same finding ACBP-P7-001 recorded about a duplicated allowlist condition).
  // ENFORCED BY: the `Record` type above, and by "the transition table is TOTAL over the vocabulary".
  return LEGAL_TRANSITIONS[from].includes(to);
}

// ── `canPickUpAutonomousWork` LIVED HERE, AND WAS DELETED BY ACBP-P7-002 ──────────────────────────────────────
//
// It read `return status === 'active';` under a docstring claiming it was "the single truth a scheduler/worker
// consults before opening a run … Pausing is the enforcement point (P1-010); the scheduler is later." It had
// ZERO PRODUCTION CALLERS for the whole of Phases 1-6, so pausing a company was a label rather than a control,
// and a green integration test named "pause blocks new autonomous-work pickup" called it directly on a value —
// proving the predicate and nothing about production.
//
// Its replacement is `mayStartAutonomousWork` in `./lifecycle-gate.ts`, which differs in three load-bearing ways:
// it takes ROWS whose `status` is `unknown` (so it can fail closed on a value the union has never heard of),
// it answers for the ACCOUNT as well as the company (ACC-004 and COMP-006 are one question), and it separates
// "not active" from "could not read". This comment is left as the marker of a deleted API, not as history.
