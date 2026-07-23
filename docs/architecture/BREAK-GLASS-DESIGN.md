# Break-Glass Access — Design Only (NOT IMPLEMENTED)

Status: DESIGN DOCUMENT ONLY. ACBP-P1-013 ships no break-glass mechanism (CDR-019; owner decision 21).
Nothing in this document exists in code, configuration, infrastructure, or the database. Building any part
of it is an OWNER GATE.

## 1. What break-glass is — and what it is not

Break-glass is the **emergency** administrative path for incidents where the routine admin surface
(ACBP-P1-013: the audited, reason-captured `admin.tenant_read` company-overview read) is insufficient —
e.g. an incident requiring broader inspection or emergency mutation of tenant state.

It is **separate from routine admin access** by construction:

- Routine admin access (P1-013) is narrow, standing, allowlist-based, and usable by a single active
  platform admin for exactly one read operation.
- Break-glass is exceptional, non-standing, broader in scope, and NEVER usable by one person alone.

Routine access must never widen to absorb break-glass use cases; pressure to "just add one more admin
operation" is the signal to design the break-glass/JIT workflow properly instead.

## 2. Required properties (all mandatory in any future implementation)

1. **Not implemented today.** No break-glass code path, role, credential, or endpoint exists. Any
   appearance of one is a security incident.
2. **Separate from routine admin access.** Distinct mechanism, distinct credentials, distinct audit
   event names (`admin.break_glass.*`, unregistered today and therefore unwritable), distinct runbook.
   Never a flag on the P1-013 path.
3. **Dual control.** Activation requires TWO distinct authenticated humans (requester + approver);
   the approver cannot be the requester. No self-approval, no standing pre-approval.
4. **Explicit incident/change reference.** Activation is invalid without a linked incident or change
   ticket id, recorded with the grant and in every resulting audit event.
5. **Time-limited credential.** Access is granted through a short-lived credential (target: minutes to
   low hours, never days) with the expiry fixed at issuance; extension requires a fresh dual-controlled
   activation.
6. **Alarms.** Activation, every action taken under it, and expiry all raise real-time alerts to the
   owner/operators — break-glass use is never quiet.
7. **Post-use review.** Every activation is followed by a mandatory review: what was accessed, why,
   whether scope was minimal, whether the routine surface should be extended instead. Review outcome
   is recorded against the incident reference.
8. **Automatic expiry/revocation.** The credential dies at its expiry time without human action, and
   can be revoked earlier at any moment; revocation does not depend on the person who activated it.
9. **No silent impersonation.** Even under break-glass, actions are recorded with the REAL operator
   identity and `actor_type` distinct from tenant users. Break-glass never mints a tenant-user session
   or executes as a member. (Same invariant as routine admin access — CDR-019.)
10. **No customer approval simulation.** Break-glass can never synthesize, forge, or replay a customer/
    tenant approval, acceptance, or consent record. Anything requiring customer approval remains blocked
    until the customer grants it.

## 3. Relationship to the full JIT approval workflow (also deferred)

P1-013's "JIT" is per-request/per-transaction scope only (CDR-019 decision 20): target-tenant context
exists solely inside one database transaction and dies at commit/rollback. The FULL JIT workflow —
request → human approval → time-boxed grant → automatic revocation, as a product feature with UI and
queues — is deferred with break-glass. Any future JIT implementation must preserve every invariant in
§2 and the P1-013 structural guarantees (restricted role, FORCE RLS intact, no BYPASSRLS, no owner
runtime connection, no impersonation, audit-before-response).

## 4. Owner gates

Implementing ANY of: break-glass activation, dual-control approval, time-boxed credentials, a third
runtime role, new SECURITY DEFINER functions, or new admin event names — each is a new architecture
decision requiring explicit owner authorization first.
