// @acbp/observability — duplicate-suppression incident recording (ACBP-P6-011; CDR-074 §0/§5; NFR-006;
// backlog acceptance "Suppressions logged").
//
// A suppressed duplicate leaves NO trace of its own: nothing is written, and the caller is told the operation
// succeeded. That is correct for the caller and blind for everyone else, because "no second row appeared" is
// equally what a broken suppression path looks like on a day nothing was re-delivered. This makes the working
// case emit something.
//
// READ THE LIMIT BEFORE TRUSTING THE COUNT (CDR-074 §5): a count of ZERO is ambiguous and this function cannot
// fix that. It is evidence that suppression FIRED, not that it would have.
import { suppressionMetadata, type SuppressionIncident } from '@acbp/contracts';
import type { Logger } from './logger.js';

/**
 * The single event name every suppression reports under, on every surface.
 *
 * Exported so tests and queries reference the same constant rather than retyping the string. One name is what
 * makes the incidents countable: per-surface names would require knowing the full list in advance to count them,
 * and a surface that quietly stopped reporting would look identical to one nobody knew to query. The surface is
 * a FIELD, so a count can be broken down without being fragmented.
 */
export const SUPPRESSION_EVENT = 'idempotency.suppressed';

/**
 * Record one duplicate-suppression incident.
 *
 * INFO, not WARN: a suppressed duplicate is the mechanism working. Warning on a correct outcome trains readers to
 * ignore warnings, which costs more than the visibility gains. The threshold at which a suppression RATE becomes
 * an alert is the owner's decision (CDR-074 §4), and surfacing it is P6-010's.
 *
 * The metadata is built by `suppressionMetadata` from named fields, so a caller-authored idempotency key cannot
 * ride along into the log even if the incident object carries one.
 */
export function recordSuppression(logger: Logger | undefined, incident: SuppressionIncident): void {
  logger?.info(SUPPRESSION_EVENT, { metadata: suppressionMetadata(incident) });
}
