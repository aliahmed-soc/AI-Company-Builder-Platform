// @acbp/contracts — provider-neutral Decision Room contract (ACBP-P6-008; CDR-076; DEC-001, ACT-001/003/004).
//
// The Decision Room is a COMPOSED READ over surfaces that already exist (approvals, held work, tasks, runs,
// artifacts, strategy options and decisions, interview questions, company usage). This module defines WHAT the
// room is — the ten queues, the tri-state section, the redacted item DTO, the integrity counter and the stream
// contract — not how any of it is queried. Zero-dependency, pure ECMAScript, like the rest of @acbp/contracts.
//
// THE TWO SHAPES OF LIE THIS CONTRACT EXISTS TO PREVENT (CDR-076 §0):
//   1. HOLLOW SUCCESS — work shown as done with no run record behind it (invariant 20, trust-critical #18). The
//      results queue is built from an evidence join, so a completed task with no succeeded run is not merely
//      filtered out: it CANNOT BE EXPRESSED here. What it can be is counted — see {@link DecisionRoomIntegrity}.
//   2. THE EMPTY QUEUE THAT IS EMPTY BECAUSE THE QUERY BROKE — in a Decision Room, "nothing needs your decision"
//      is a POSITIVE CLAIM, and a silently degraded section renders identically to a calm day. Hence
//      {@link DecisionRoomSectionStatus}: `ok` (this surface knows, and this is the answer), `restricted` (the
//      caller may not be told) and `unavailable` (this surface does not know) are three different sentences, and
//      `count` is `null` for the latter two so a consumer cannot render "0" from a section that never ran.
import type { RollupFigures } from '../usage/rollup.js';

/**
 * The ten queues of DEC-001 / PRD §11.4, in canonical render order. CLOSED and ordered: a response carries
 * exactly these ten, exactly once each, always in this order ({@link decisionRoomQueuesComplete} is the guard),
 * so "one of the ten silently stopped being produced" is a test failure rather than a quiet omission.
 */
export const DECISION_ROOM_QUEUES = [
  'needs_your_decision',
  'recommended_next_actions',
  'questions_from_ai',
  'options_under_consideration',
  'approved_and_queued',
  'executing',
  'results',
  'blocked_work',
  'failed_work',
  'recent_decisions',
] as const;
export type DecisionRoomQueue = (typeof DECISION_ROOM_QUEUES)[number];

export function isDecisionRoomQueue(value: unknown): value is DecisionRoomQueue {
  return typeof value === 'string' && (DECISION_ROOM_QUEUES as readonly string[]).includes(value);
}

/**
 * What an item IS, so a consumer never has to infer an entity's type from the queue it arrived in (the same row
 * kind legitimately appears in several queues — a task shows up in `executing`, `results` and `failed_work`).
 */
export const DECISION_ROOM_ITEM_KINDS = [
  'task',
  'approval_request',
  'approval_decision',
  'held_work',
  'strategy_option',
  'strategy_decision',
  'interview_question',
] as const;
export type DecisionRoomItemKind = (typeof DECISION_ROOM_ITEM_KINDS)[number];

/**
 * Proposed-vs-executed marking (ACT-003, invariant 20). Reproduced here as its own union rather than imported
 * from the activity contract because the two surfaces mark DIFFERENT things: the feed marks events (all of which
 * already happened), whereas the room marks WORK, most of which has not.
 */
export type DecisionRoomExecutionState = 'proposed' | 'executed';

/** Bounded, primitive-only display detail. Same posture as the feed's summary: no free-text payloads. */
export type DecisionRoomDetail = Readonly<Record<string, string | number | boolean>>;

/**
 * A redacted room item. Carries the entity id, its kind, a TENANT-AUTHORED title (already visible to this member
 * through the surface the row came from), the proposed/executed marking, the ordering instant, and a bounded
 * detail map. It deliberately does NOT carry: raw model output, tool payloads, approval payload hashes, actor
 * internal ids, account/company ids, or correlation/causation/idempotency ids (CDR-076 §3-G10).
 */
export interface DecisionRoomItem {
  readonly id: string;
  readonly kind: DecisionRoomItemKind;
  readonly title: string;
  readonly state: DecisionRoomExecutionState;
  readonly occurredAt: string;
  readonly detail: DecisionRoomDetail;
}

/**
 * `ok` — the section ran and this is its answer (an empty `ok` section is the positive claim "there is nothing
 *   here"); `restricted` — the caller lacks the section's own domain action, so it is not their answer to have;
 * `unavailable` — the section's read failed and this surface does not know. See CDR-076 §0/§3-G1.
 */
export type DecisionRoomSectionStatus = 'ok' | 'restricted' | 'unavailable';

/**
 * One queue's result. `count` is `number` when and only when `status === 'ok'`, and `null` otherwise — the
 * distinction that stops a broken section from rendering as "all clear". `truncated` says the queue holds more
 * than {@link DECISION_ROOM_ITEM_CAP} rows, so a short `items` array is never mistaken for the whole queue
 * (`count` remains the true total).
 */
export interface DecisionRoomSection {
  readonly queue: DecisionRoomQueue;
  readonly status: DecisionRoomSectionStatus;
  readonly count: number | null;
  readonly items: readonly DecisionRoomItem[];
  readonly truncated: boolean;
}

/** Per-section item cap. The COUNT is always the true total; only the rendered sample is bounded. */
export const DECISION_ROOM_ITEM_CAP = 20;

/**
 * Integrity signals the room refuses to swallow.
 *
 * `unverifiedCompletions` — tasks marked `completed` with NO succeeded run record for them. They are excluded
 * from the results queue by construction (invariant 20), but excluding them silently would be its own
 * dishonesty: a completion that vanishes is as misleading as a completion that lies. Expected value is 0; a
 * non-zero value is a data-integrity signal, not a queue. `null` when the count could not be established.
 *
 * It is a COUNT, not a diagnosis: it says how many, never which or why (CDR-076 §6).
 */
export interface DecisionRoomIntegrity {
  readonly unverifiedCompletions: number | null;
}

/**
 * ACT-004 usage visibility, scoped to THIS COMPANY only. `usage_events` is dual-keyed to account and company, so
 * a company-scoped read returns this company's usage and nothing else — no account-wide figure appears in a
 * company-scoped room (CDR-076 §3-G8). Gated on the existing owner-only `usage:read`; a viewer sees `restricted`.
 */
export interface DecisionRoomUsage {
  readonly status: DecisionRoomSectionStatus;
  readonly figures: RollupFigures | null;
}

/**
 * The room. `asOf` is the POSTGRESQL transaction read timestamp of the single snapshot all sections were read in
 * (never application wall-clock) — the same honesty rule the activity feed applies. `digest` is the change token
 * the stream compares (see {@link decisionRoomDigest}).
 */
export interface DecisionRoomView {
  readonly sections: readonly DecisionRoomSection[];
  readonly integrity: DecisionRoomIntegrity;
  readonly usage: DecisionRoomUsage;
  readonly asOf: string;
  readonly digest: string;
}

// ── Section constructors: make the count/status contract hard to violate ──────────────────────────────────────

/** An `ok` section: the count is the TRUE total, `items` the (possibly capped) sample. */
export function okSection(queue: DecisionRoomQueue, items: readonly DecisionRoomItem[], total: number): DecisionRoomSection {
  const capped = items.length > DECISION_ROOM_ITEM_CAP ? items.slice(0, DECISION_ROOM_ITEM_CAP) : items;
  return Object.freeze({ queue, status: 'ok' as const, count: total, items: Object.freeze(capped), truncated: total > capped.length });
}

/**
 * A section that did NOT produce an answer. `count` is `null` and `items` empty BY CONSTRUCTION — there is no
 * code path that can hand back a `restricted`/`unavailable` section carrying a zero count.
 */
export function nonAnsweringSection(queue: DecisionRoomQueue, status: 'restricted' | 'unavailable'): DecisionRoomSection {
  return Object.freeze({ queue, status, count: null, items: Object.freeze([] as readonly DecisionRoomItem[]), truncated: false });
}

/** True IFF the section's count/status pairing is legal: a count exists exactly when the section answered. */
export function sectionCountIsConsistent(section: DecisionRoomSection): boolean {
  return section.status === 'ok' ? typeof section.count === 'number' && section.count >= 0 : section.count === null && section.items.length === 0;
}

/** True IFF `sections` is exactly the ten canonical queues, once each, in canonical order. */
export function decisionRoomQueuesComplete(sections: readonly DecisionRoomSection[]): boolean {
  return sections.length === DECISION_ROOM_QUEUES.length && DECISION_ROOM_QUEUES.every((q, i) => sections[i]?.queue === q);
}

// ── Change digest (what the stream compares) ──────────────────────────────────────────────────────────────────

/**
 * A deterministic change token over everything the room asserts: each section's status, true count and newest
 * item id, plus the integrity counter and the usage figures.
 *
 * DELIBERATELY NOT HASHED. A hash would be shorter and could COLLIDE, and a collision here means a change the
 * founder is never told about — which is precisely the class of silent failure this whole surface is built to
 * avoid (CDR-076 §0). The material is bounded (ten sections, one id each), so exactness costs a few hundred
 * bytes per tick and buys a guarantee.
 */
export function decisionRoomDigest(sections: readonly DecisionRoomSection[], integrity: DecisionRoomIntegrity, usage: DecisionRoomUsage): string {
  const parts = sections.map((s) => `${s.queue}=${s.status}:${s.count ?? '-'}:${s.items[0]?.id ?? ''}`);
  parts.push(`integrity=${integrity.unverifiedCompletions ?? '-'}`);
  const f = usage.figures;
  parts.push(`usage=${usage.status}:${f === null ? '-' : `${f.eventCount},${f.inputTokens},${f.outputTokens},${f.estimatedCostMicros}`}`);
  return parts.join('|');
}

// ── Stream contract (SSE) ─────────────────────────────────────────────────────────────────────────────────────

/**
 * HOW THE STREAM ACTUALLY WORKS, stated in its own payload (CDR-076 §3-G6). There is no transactional outbox and
 * no LISTEN/NOTIFY in this system — P1-009 deferred the outbox deliberately — so this stream RE-READS the digest
 * on a bounded interval and emits when it changes. Calling that "push" would claim a mechanism that does not
 * exist, so the contract says `poll_backed` and promises only: *you will learn of a change within one interval*.
 */
export type DecisionRoomDeliveryMode = 'poll_backed';

/**
 * One stream message. Carries the change token and the per-queue counts ONLY — never queue payloads, so a
 * long-lived connection cannot become a slow leak of item content, and a client that wants detail re-reads the
 * room through the authorized request path.
 */
export interface DecisionRoomStreamEvent {
  readonly deliveryMode: DecisionRoomDeliveryMode;
  readonly intervalSeconds: number;
  readonly asOf: string;
  readonly digest: string;
  readonly counts: Readonly<Partial<Record<DecisionRoomQueue, number | null>>>;
}

// Bounds: a client cannot ask for a tighter loop than the floor (protects the database from an authorized
// caller), nor a longer-lived connection than the ceiling (every stream ends on its own).
export const DECISION_ROOM_STREAM_INTERVAL_MS_DEFAULT = 5_000;
export const DECISION_ROOM_STREAM_INTERVAL_MS_MIN = 2_000;
export const DECISION_ROOM_STREAM_INTERVAL_MS_MAX = 60_000;
export const DECISION_ROOM_STREAM_MAX_LIFETIME_MS = 300_000;

/** Clamp a requested tick interval into [MIN, MAX], defaulting when absent/invalid. */
export function clampStreamIntervalMs(requested: unknown): number {
  const n = typeof requested === 'number' ? requested : typeof requested === 'string' ? Number(requested) : NaN;
  if (!Number.isFinite(n) || Number.isNaN(n)) return DECISION_ROOM_STREAM_INTERVAL_MS_DEFAULT;
  const i = Math.floor(n);
  if (i < DECISION_ROOM_STREAM_INTERVAL_MS_MIN) return DECISION_ROOM_STREAM_INTERVAL_MS_MIN;
  return Math.min(i, DECISION_ROOM_STREAM_INTERVAL_MS_MAX);
}

/** Build the counts map a stream event carries from a room view. */
export function streamCountsOf(sections: readonly DecisionRoomSection[]): Readonly<Partial<Record<DecisionRoomQueue, number | null>>> {
  const out: Partial<Record<DecisionRoomQueue, number | null>> = {};
  for (const s of sections) out[s.queue] = s.count;
  return Object.freeze(out);
}
