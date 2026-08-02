// @acbp/contracts — duplicate-suppression incidents (ACBP-P6-011; CDR-074 §0/§5; TASK-009, NFR-006;
// backlog acceptance "Suppressions logged").
//
// WHY A SUPPRESSION IS RECORDED AT ALL. Canon says the user-visible outcome of a suppressed duplicate is
// "invisible (correct)" (FAILURE-AND-RECOVERY row 11). That is right for the user and treacherous for everyone
// operating the system, because "nothing happened twice" is also what a system with NO duplicate suppression
// looks like on a day when nothing was delivered twice. Recording the incident makes the working case visible.
//
// WHAT IT DOES NOT DO, stated here because the counter is easy to oversell: a count of ZERO is still ambiguous.
// A suppression path that silently stopped working and a genuinely quiet week both report nothing. CDR-074 §5
// names the three separate things that close that ambiguity -- the mechanism EXISTS (checked), is REACHABLE
// (the caller supplies a key), and FIRES (the replay suite) -- and this counter is only evidence for the third.

/**
 * The surfaces that report a suppression incident.
 *
 * DELIBERATELY SHORT: these are the three ACBP-P6-011 actually wires, matching the backlog's "across
 * jobs/events/usage". Other tables carry duplicate suppression (CDR-074 §1 lists seven) and are NOT listed,
 * because a surface named here that nothing reports would claim coverage this ticket does not have -- the same
 * "registered but not wired" trap the usage key itself is careful about. Adding a surface is one line, plus the
 * call site that earns it.
 */
export const IDEMPOTENCY_SUPPRESSION_SURFACES = ['job_enqueue', 'identity_event', 'usage_event'] as const;

export type IdempotencySuppressionSurface = (typeof IDEMPOTENCY_SUPPRESSION_SURFACES)[number];

export function isIdempotencySuppressionSurface(value: unknown): value is IdempotencySuppressionSurface {
  return typeof value === 'string' && (IDEMPOTENCY_SUPPRESSION_SURFACES as readonly string[]).includes(value);
}

/**
 * One suppression: a delivery arrived, was recognised as already recorded, and nothing was written.
 *
 * A UNION RATHER THAN NULLABLE FIELDS, so "which surfaces have a tenant" is checked by the compiler instead of
 * being a convention. `identity_event` is the webhook-receipt dedupe, and identity mappings are GLOBAL by design
 * -- they carry no account or company at all. With plain `string | null` fields, a tenant-scoped surface could
 * quietly record nulls and nothing would object; here that does not typecheck. Adding a surface forces the same
 * question to be answered again, which is the point.
 *
 * The nulls stay explicit in the recorded metadata rather than being omitted: an absent field reads as "we forgot
 * to record it", a null reads as "this surface has none", and only one of those is true.
 */
export type SuppressionIncident =
  | { readonly surface: 'job_enqueue' | 'usage_event'; readonly accountId: string; readonly companyId: string }
  | { readonly surface: 'identity_event'; readonly accountId: null; readonly companyId: null };

/**
 * The redaction-safe metadata for one suppression incident.
 *
 * BUILT FROM NAMED FIELDS, NEVER SPREAD, and that is the whole point of this function existing rather than the
 * call sites passing the incident straight to the logger. An idempotency key is CALLER-SUPPLIED and unbounded:
 * a caller is free to mint one containing an email, a customer name, or a fragment of the payload it
 * de-duplicates. A suppression record is a log line, so spreading the incident would publish whatever the caller
 * put in the key. The key is therefore never recorded at all -- surface, account and company are enough to find
 * the re-delivering producer, and none of them are caller-authored.
 */
export function suppressionMetadata(incident: SuppressionIncident): Record<string, unknown> {
  return { surface: incident.surface, accountId: incident.accountId, companyId: incident.companyId };
}
