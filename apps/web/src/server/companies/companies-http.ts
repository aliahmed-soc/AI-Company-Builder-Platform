// ACBP-P1-010 — safe HTTP mapping + bounded body parsing for the companies routes (apps/web).
//
// Keeps Next types out of the domain and never leaks internals. Bodies are size-capped and JSON-typed; only
// the expected keys survive parsing. Field-level validation is the domain's job (@acbp/core). A denial is the
// same opaque 403 regardless of cause (not a member vs not allowed) — no oracle.
import { isJsonContentType, genericErrorBody } from '../webhooks/http.js';
import { readLimitedRawBody, type RawBodyRequest } from '../webhooks/raw-body.js';
import type { StopRefusalReason } from '@acbp/core';
import type { CompaniesRequestResult } from './companies-request.js';

export const MAX_COMPANIES_BODY_BYTES = 16 * 1024;

type Parsed<T> = { readonly ok: true; readonly input: T } | { readonly ok: false; readonly status: number };
type HttpRequest = RawBodyRequest & { readonly headers: Pick<Headers, 'get'> };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/**
 * A throttled response: 429, the standard `Retry-After` header, and the generic envelope (ACBP-P7-013).
 *
 * Exported so every surface throttles IDENTICALLY. Four request modules each writing their own 429 is four
 * chances for one of them to leak a limit value or forget the header, and the shape of a refusal is exactly the
 * kind of detail that drifts between hand-written copies.
 */
export function rateLimitedResponse(retryAfterSeconds: number): Response {
  return new Response(JSON.stringify(genericErrorBody(429)), {
    status: 429,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Whole seconds, floored at 1 — RFC 9110 requires a non-negative integer, and `Retry-After: 0` invites an
      // immediate retry certain to be refused again.
      'retry-after': String(Math.max(1, Math.ceil(retryAfterSeconds))),
    },
  });
}

async function readJsonObject(request: HttpRequest): Promise<{ ok: true; obj: Record<string, unknown> } | { ok: false; status: number }> {
  if (!isJsonContentType(request.headers.get('content-type'))) return { ok: false, status: 415 };
  const body = await readLimitedRawBody(request, MAX_COMPANIES_BODY_BYTES);
  if (!body.ok) return { ok: false, status: body.reason === 'too_large' ? 413 : 400 };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body.bytes);
  } catch {
    return { ok: false, status: 400 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: 400 };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, status: 400 };
  return { ok: true, obj: parsed as Record<string, unknown> };
}

/** Parse a create-company body → { creationMode, name, description } (raw values; the domain validates). */
export async function parseCreateCompanyBody(request: HttpRequest): Promise<Parsed<{ creationMode: unknown; name: unknown; description: unknown }>> {
  const r = await readJsonObject(request);
  if (!r.ok) return { ok: false, status: r.status };
  return { ok: true, input: { creationMode: r.obj['creationMode'], name: r.obj['name'], description: r.obj['description'] } };
}

/** Parse a rename/profile-edit body → { name, description } (raw values; the domain validates). */
export async function parseRenameCompanyBody(request: HttpRequest): Promise<Parsed<{ name: unknown; description: unknown }>> {
  const r = await readJsonObject(request);
  if (!r.ok) return { ok: false, status: r.status };
  return { ok: true, input: { name: r.obj['name'], description: r.obj['description'] } };
}

/**
 * Parse the recommend body → { generationId } (a non-empty string; core decides whether it names anything).
 *
 * ⚠️ THE ONLY BODY ON A METERED ROUTE, which is why it is here and not a local `parseBody` in the route file.
 * The four routes beside it (`roadmap/edit`, `decisions`, `strategy/selection`, `tasks/{id}/delete`) each read
 * their body with a bare `request.json()` — no size cap, no content-type check — and `strategy/recommend`
 * originally followed them. Following a convention is not a reason when the convention is the defect: there is
 * no global body cap in `apps/web`, so a bare `request.json()` lets an UNAUTHENTICATED caller make the server
 * buffer and parse an arbitrarily large payload, and this is the one route of the four that spends money.
 *
 * `readJsonObject` already owns the 16 KiB cap (rejecting an over-large declared `Content-Length` before reading
 * a byte, and independently counting streamed bytes) and the 415. This adds only the shape check.
 *
 * The blank/non-string refusal is deliberate and is NOT an authorization decision: an id that cannot name a
 * generation is refused before it consumes a rate-limit token, while whether a well-formed id names a generation
 * the caller may REACH stays core's ruling and returns `not_found` (CDR-088 §1).
 */
export async function parseRecommendBody(request: HttpRequest): Promise<Parsed<{ generationId: string }>> {
  const r = await readJsonObject(request);
  if (!r.ok) return { ok: false, status: r.status };
  const generationId = r.obj['generationId'];
  if (typeof generationId !== 'string' || generationId.trim() === '') return { ok: false, status: 400 };
  return { ok: true, input: { generationId } };
}

/**
 * ACBP-API-011 — parse an activate-stop body → { scope, targetId, reason } (RAW values; the domain validates).
 *
 * THE SHARED BOUNDED PARSER, not a bare `request.json()`, and the reasoning is `parseRecommendBody`'s applied to a
 * different kind of cost. There is no global body cap in `apps/web`, so a bare parse lets a caller make the server
 * buffer and parse an arbitrarily large payload before anything has authorized them. `parseRecommendBody` took this
 * treatment because it was the one route that spends money; this is the one route that HALTS THE PLATFORM, and an
 * unbounded read in front of an emergency control is the same defect with a worse consequence.
 *
 * NO SHAPE CHECK ON `scope`, DELIBERATELY — unlike `parseRecommendBody`, which refuses a blank `generationId`.
 * `activateStop` types `scope` as `unknown` because refusing a bad scope is ITS job: two of the seven scopes are
 * refused BY NAME as unenforceable, and a boundary that pre-filtered them would replace a specific, actionable
 * refusal with a generic 400. Every key is forwarded exactly as received.
 */
export async function parseActivateStopBody(request: HttpRequest): Promise<Parsed<{ scope: unknown; targetId: unknown; reason: unknown }>> {
  const r = await readJsonObject(request);
  if (!r.ok) return { ok: false, status: r.status };
  return { ok: true, input: { scope: r.obj['scope'], targetId: r.obj['targetId'], reason: r.obj['reason'] } };
}

/**
 * ACBP-API-013 — parse an evaluate-answer body → { answerText } (a non-blank string; core judges the answer).
 *
 * THE SHARED BOUNDED PARSER, for `parseRecommendBody`'s reason: there is no global body cap in `apps/web`, and
 * this route spends money per call. The blank/non-string refusal is a SHAPE check, not a judgement about the
 * answer — whether the text is vague, contradictory or clear is precisely what the metered call decides, and
 * pre-judging it here would be the client-side scoring ACBP-FE-008 explicitly forbids. Refusing an empty body
 * before it consumes a rate-limit token is the only thing this adds.
 */
export async function parseEvaluateAnswerBody(request: HttpRequest): Promise<Parsed<{ answerText: string }>> {
  const r = await readJsonObject(request);
  if (!r.ok) return { ok: false, status: r.status };
  const answerText = r.obj['answerText'];
  if (typeof answerText !== 'string' || answerText.trim() === '') return { ok: false, status: 400 };
  return { ok: true, input: { answerText } };
}

/** Parse an answer-submission body → { status, content } (raw values; the domain validates). */
export async function parseAnswerBody(request: HttpRequest): Promise<Parsed<{ status: unknown; content: unknown }>> {
  const r = await readJsonObject(request);
  if (!r.ok) return { ok: false, status: r.status };
  return { ok: true, input: { status: r.obj['status'], content: r.obj['content'] } };
}

/** Parse a memory-item create body → { type, content, sourceType, sourceRef, confidence } (raw; domain validates). */
export async function parseCreateMemoryBody(request: HttpRequest): Promise<Parsed<{ type: unknown; content: unknown; sourceType: unknown; sourceRef: unknown; confidence: unknown }>> {
  const r = await readJsonObject(request);
  if (!r.ok) return { ok: false, status: r.status };
  return { ok: true, input: { type: r.obj['type'], content: r.obj['content'], sourceType: r.obj['sourceType'], sourceRef: r.obj['sourceRef'], confidence: r.obj['confidence'] } };
}

/** Parse a memory-item edit body → { type, content, confidence } (raw; the domain validates). source_type/ref
 *  are NOT caller-settable on an edit — the correction is always a user_edit citing the target. */
export async function parseEditMemoryBody(request: HttpRequest): Promise<Parsed<{ type: unknown; content: unknown; confidence: unknown }>> {
  const r = await readJsonObject(request);
  if (!r.ok) return { ok: false, status: r.status };
  return { ok: true, input: { type: r.obj['type'], content: r.obj['content'], confidence: r.obj['confidence'] } };
}

/**
 * Run a companies request use case and map it, converting ANY unexpected throw into the BOUNDED generic 500
 * envelope (ACBP-P1-014 Class R restoration).
 *
 * Why: the accepted platform invariant is that every cross-boundary/HTTP error is bounded and sanitized. The
 * P1-012/P1-013 routes already wrap their handlers, but the older company routes let a thrown PlatformError
 * escape the handler — e.g. a malformed `companyId` reaches the resolver's uuid cast and raises 22P02. The
 * framework would then produce its own 500, outside our envelope contract. This restores the invariant
 * without changing any success or denial semantics: statuses and bodies for every already-mapped outcome are
 * untouched; only the previously-unmapped throw path becomes `{"error":"internal_error"}` with status 500.
 */
export async function respondToCompaniesRequest(run: () => Promise<CompaniesRequestResult>): Promise<Response> {
  try {
    return toCompaniesResponse(await run());
  } catch {
    return jsonResponse(500, genericErrorBody(500));
  }
}

/**
 * ACBP-API-011 — which HTTP status each stop refusal deserves (CDR-072).
 *
 * `STOP_REFUSAL_REASONS` is ONE closed union spanning THREE different kinds of "no", so a single status for all
 * eleven would be wrong for at least eight of them:
 *
 *   400 — the request itself is malformed. A scope that is not a scope, a scope that cannot be enforced, a target
 *         supplied where none is allowed or missing where one is required, or a `company` stop naming a company
 *         other than its own. Sending it again unchanged cannot succeed.
 *   404 — the thing named does not exist HERE. Under RLS a foreign tenant's row is invisible rather than denied, so
 *         "not yours" and "not there" are genuinely the same answer and no oracle is created by saying so.
 *   409 — well-formed, authorized, and refused by current state. `already_active` means the halt you asked for is
 *         ALREADY IN FORCE, which is the one refusal an operator must never read as a failure to stop.
 *
 * EXHAUSTIVE BY CONSTRUCTION: the `Record<StopRefusalReason, number>` makes a reason added to core without a status
 * here a COMPILE error, rather than a silent fall-through to some default that would be wrong for it.
 *
 * ⚠️ FOUR OF THE ELEVEN HAVE NO PRODUCER ON THIS RELEASE'S ROUTES, disclosed rather than quietly mapped (the
 * CDR-092 §10 discipline). `not_found`, `not_active`, `already_reviewed` and `stop_still_active` are raised only by
 * `clearStop` and `reviewHeldWork`, and neither is routed (owner ruling 2026-08-19). Their mappings are correct and
 * currently unreachable; that is a different statement from "the clear path is covered", and nothing here should be
 * read as evidence that it is. They are mapped anyway because the Record must be total for the compile-time
 * exhaustiveness above to hold.
 */
const STOP_REFUSAL_STATUS: Readonly<Record<StopRefusalReason, number>> = {
  not_a_scope: 400,
  scope_not_enforceable: 400,
  target_required: 400,
  target_not_allowed: 400,
  target_must_be_own_company: 400,
  target_not_found: 404,
  not_found: 404,
  already_active: 409,
  not_active: 409,
  already_reviewed: 409,
  stop_still_active: 409,
};

/** Map a bounded companies result to a safe HTTP response. */
export function toCompaniesResponse(result: CompaniesRequestResult): Response {
  switch (result.status) {
    case 'created':
      return jsonResponse(201, { company: { companyId: result.companyId, status: result.companyStatus, creationMode: result.creationMode } });
    case 'company':
      return jsonResponse(200, { company: result.company });
    // CDR-087 §5.0 G9 — an absent generation is a SUCCESS carrying null, never a 404. The company exists and the
    // caller may read it; there is simply nothing generated yet, which is the honest first-visit empty state.
    case 'strategy':
      return jsonResponse(200, { generation: result.generation });
    // CDR-088 §5 — same rule as G9 above: `roadmap` may be null and that is a 200, not a 404. The company exists
    // and the caller may read it; there is simply nothing planned yet.
    case 'roadmap':
      return jsonResponse(200, { roadmap: result.roadmap });
    case 'tasks':
      return jsonResponse(200, { board: result.board });
    case 'task':
      return jsonResponse(200, { task: result.task });
    case 'artifact':
      return jsonResponse(200, { artifact: result.artifact });
    // An empty list is a 200. There is no not_found arm to map (CDR-088 §2.1a): an unknown run and an empty run
    // are the same answer from core, and this layer must not invent a distinction core did not make.
    case 'artifacts':
      return jsonResponse(200, { artifacts: result.artifacts });
    case 'lineage':
      return jsonResponse(200, { lineage: result.lineage });
    case 'approvals':
      return jsonResponse(200, { approvals: result.approvals });
    case 'task_deleted':
      return jsonResponse(200, { taskId: result.taskId, stateAtDelete: result.stateAtDelete });
    // 409, not 400: the request was well-formed and authorized, but conflicts with the task's current state.
    // Its own code, because "cancel it first" is a different instruction from "confirm it first".
    case 'control_unavailable':
      return jsonResponse(409, { error: 'control_unavailable', reason: result.reason });
    // 409 as well, and DELIBERATELY not 400: the caller did not send a malformed request, they sent an
    // unconfirmed one. A 400 would invite a retry with the same body; this names what is missing.
    case 'confirmation_required':
      return jsonResponse(409, { error: 'confirmation_required' });
    case 'run':
      return jsonResponse(200, { run: result.run });
    // An empty list is a 200 — CDR-089 §3. There is no not_found arm to map, and this layer must not invent a
    // distinction core deliberately does not make.
    case 'runs':
      return jsonResponse(200, { runs: result.runs });
    // 200, not 201: the edit revises the company's current roadmap in place from the client's perspective — it
    // is read back through the same GET, so there is no new URL a 201 could point at.
    case 'roadmap_edited':
      return jsonResponse(200, { roadmap: result.roadmap, flaggedTaskCount: result.flaggedTaskCount });
    // Both are 409 — the request was well-formed and authorized, but conflicts with server state — and both keep
    // their OWN code, because the client's next move differs: `stale_version` means re-read and retry, while
    // `decision_rejected` means retrying is futile until the strategy decision changes.
    case 'stale_version':
      return jsonResponse(409, { error: 'stale_version' });
    case 'decision_rejected':
      return jsonResponse(409, { error: 'decision_rejected' });
    // 200, not 201. Neither call creates a resource at a new URL the client can then GET — the selection and the
    // decision are read back through the company's strategy surface — so 201 would promise a Location that does
    // not exist. Recorded here rather than defaulted (CDR-087 §5).
    case 'strategy_selected':
      return jsonResponse(200, { selection: result.selection });
    case 'decision_recorded':
      return jsonResponse(200, { decision: result.decision });
    // ── ACBP-API-008 slice 3b — the metered generate answers (CDR-092) ────────────────────────────────────────
    // 200 and not 201, on the same reasoning as the two above: none of these creates a resource at a new URL a
    // client could then GET. Each is read back through the surface it belongs to — GET strategy, GET roadmap,
    // GET tasks — so a 201 would promise a Location that does not exist.
    case 'strategy_generated':
      return jsonResponse(200, { generation: result.generation });
    case 'strategy_recommended':
      return jsonResponse(200, { recommendation: result.recommendation });
    case 'roadmap_generated':
      return jsonResponse(200, { roadmap: result.roadmap });
    // An explicit ALLOWLIST, never `...result`. Spreading would publish `status` today and whatever core's ok
    // arm gains tomorrow — the exact defect the approvals inbox allowlist exists to prevent (CDR-088 §2.1c).
    case 'tasks_generated':
      return jsonResponse(200, {
        tasks: result.tasks,
        partial: result.partial,
        tasksMissingType: result.tasksMissingType,
        milestonesOmitted: result.milestonesOmitted,
        tasksMissingRationale: result.tasksMissingRationale,
        memoryItemsConsidered: result.memoryItemsConsidered,
      });
    // The eight state conflicts. All 409 — well-formed, authorized, and refused by the company's current state —
    // and each keeps its OWN code because the next move differs for every one of them. A single generic 409
    // would leave a founder guessing which of eight things to do.
    case 'no_understanding':
      return jsonResponse(409, { error: 'no_understanding' });
    case 'not_confirmed':
      return jsonResponse(409, { error: 'not_confirmed' });
    case 'stale_understanding':
      return jsonResponse(409, { error: 'stale_understanding' });
    case 'no_decision':
      return jsonResponse(409, { error: 'no_decision' });
    case 'stale_decision':
      return jsonResponse(409, { error: 'stale_decision' });
    case 'no_roadmap':
      return jsonResponse(409, { error: 'no_roadmap' });
    case 'no_milestones_in_scope':
      return jsonResponse(409, { error: 'no_milestones_in_scope' });
    case 'stale_roadmap':
      return jsonResponse(409, { error: 'stale_roadmap' });
    // 502, deliberately not 503 and not 500: an UPSTREAM provider call failed or returned something unusable.
    // 503 would say this platform is down while it is answering every other route fine; 500 would blame a defect
    // here. Nothing was persisted either way — no phantom options, no phantom tasks. No provider detail travels.
    case 'generation_failed':
      return jsonResponse(502, { error: 'generation_failed' });
    case 'recommendation_failed':
      return jsonResponse(502, { error: 'recommendation_failed' });
    /**
     * 402, and deliberately WITHOUT `Retry-After` (CDR-092 §4).
     *
     * The header's absence is the second signal, readable without parsing a body: 429 says wait and retry, 402
     * says retrying cannot help until a human tops the account up. An automated client handed 429 for an
     * exhausted budget would retry forever against a wall.
     *
     * ⚠️ CDR-092 §10 — UNREACHABLE TODAY. Nothing on the generate paths debits credit, so no code path returns
     * this status. The mapping is correct and the trigger does not exist; ACBP-API-009 is the wiring. This must
     * not be reported as a working budget control.
     */
    case 'budget_exhausted':
      return jsonResponse(402, { error: 'budget_exhausted' });
    case 'renamed':
      return jsonResponse(200, result.version !== undefined ? { changed: result.changed, version: result.version } : { changed: result.changed });
    case 'transitioned':
      return jsonResponse(200, { status: result.companyStatus });
    case 'validation':
      return jsonResponse(400, { error: result.error });
    case 'activity':
      // The typed page: redacted items + honest metadata (projectionMode/asOf/sourceThrough/lagSeconds). Never a
      // raw activity/audit row serialization.
      return jsonResponse(200, {
        items: result.page.items,
        nextCursor: result.page.nextCursor,
        projectionMode: result.page.projectionMode,
        asOf: result.page.asOf,
        sourceThrough: result.page.sourceThrough,
        lagSeconds: result.page.lagSeconds,
      });
    case 'decision_room':
      // The whole room in one body: ten sections, each carrying its own status, so a client cannot render a
      // section it never received. `integrity` and `usage` are part of the room, not a separate endpoint —
      // splitting them would let a UI show the queues while silently dropping the unverified-completion count.
      return jsonResponse(200, { room: result.room });
    case 'portfolio':
      // The typed portfolio page: redacted items {companyId,name,status,role,createdAt} + the opaque nextCursor.
      // No accountId, actor ids, totals, metrics or aggregates (CDR-017 §9).
      return jsonResponse(200, { items: result.page.items, nextCursor: result.page.nextCursor });
    case 'provisioning':
      // The redacted ordered six-step status (ACBP-P1-012; CDR-018 §12): approved fields only — no accountId,
      // actor/membership ids, free-text failure messages, or internal error detail.
      return jsonResponse(200, {
        companyId: result.provisioning.companyId,
        companyStatus: result.provisioning.companyStatus,
        steps: result.provisioning.steps,
        nextIncompleteStep: result.provisioning.nextIncompleteStep,
        resumable: result.provisioning.resumable,
        exhausted: result.provisioning.exhausted,
        completed: result.provisioning.completed,
      });
    case 'interview':
      // The redacted interview session DTO (ACBP-P2-001; CDR-022): sessionId, companyId, state, honest phase,
      // and timestamps. No accountId, actor ids, or internal detail.
      return jsonResponse(200, { session: result.session });
    case 'company_not_active':
      // An interview can only start on an active company (WORKFLOW §2). Coarse, non-oracle 409.
      return jsonResponse(409, { error: 'company_not_active' });
    case 'answer':
      // The redacted answer DTO (ACBP-P2-002): questionId, revision, status, content, createdAt. `created`
      // distinguishes a new revision from an idempotent no-op. No accountId/actor.
      return jsonResponse(200, { answer: result.answer, created: result.created });
    case 'qa':
      // The redacted session Q&A: questions in order, each with current answer + full revision history +
      // derived lifecycle. No accountId/actor ids.
      return jsonResponse(200, { qa: result.qa });
    case 'memory_item':
      // The redacted typed memory item (ACBP-P2-006): type, content, sourceType, sourceRef, confidence,
      // confirmationState, supersededBy, createdAt. No accountId/actor. 201 Created.
      return jsonResponse(201, { item: result.item });
    case 'memory_list':
      // The company's memory items (redacted; newest-first, bounded). No accountId/actor ids.
      return jsonResponse(200, { items: result.items });
    case 'memory_item_single':
      // A single redacted memory item.
      return jsonResponse(200, { item: result.item });
    case 'memory_edited':
      // An edit is a versioned supersede — 200 with the NEW (correcting) version. A lost version-guard race maps
      // to the existing `conflict` → 409 (below).
      return jsonResponse(200, { item: result.item });
    case 'memory_deleted':
      // A soft delete — bounded 200 confirmation echoing the id. No content/actor/timestamp leaked.
      return jsonResponse(200, { memoryItemId: result.memoryItemId });
    case 'invalid_transition':
      return jsonResponse(409, { error: 'invalid_transition', from: result.from });
    case 'conflict':
      return jsonResponse(409, { error: 'conflict' });
    case 'invalid_cursor':
      return jsonResponse(400, { error: 'invalid_cursor' });
    case 'invalid_limit':
      return jsonResponse(400, { error: 'invalid_limit' });
    case 'forbidden':
      return jsonResponse(403, { error: 'forbidden' });
    case 'not_found':
      return jsonResponse(404, { error: 'not_found' });
    case 'unavailable':
      return jsonResponse(503, { error: 'unavailable' });
    case 'email_unverified':
      return jsonResponse(403, { error: 'email_unverified' });
    case 'rate_limited':
      // CDR-008 §8's request ceiling (ACBP-P7-013; CDR-082). 429 with `Retry-After`, and the BODY carries the
      // same opaque envelope as every other refusal — no bucket balance, no limit value, no scope name.
      //
      // The HEADER is a different matter, and an earlier version of this comment claimed otherwise. Its value is
      // computed from the refusing rule's refill rate, so its magnitude differs per scope — roughly 12s for the
      // company ceiling against 1s for the session and account ones — and `60 / retryAfter` recovers the
      // configured per-minute rate. That disclosure is unavoidable while the retry advice is honest, and honest
      // advice is worth more than hiding a rate an attacker can measure by timing anyway. Stated plainly rather
      // than claimed away: the body is opaque, the header is truthful.
      return rateLimitedResponse(result.retryAfterSeconds);
    // ── ACBP-API-011 — the emergency stop (CDR-072) ───────────────────────────────────────────────────────────
    case 'stop_state':
      return jsonResponse(200, { stopState: result.stopState });
    // 200 and not 201 on the same reasoning as the generate answers above: a stop is read back through GET
    // /stops, not at a new URL a client could follow, so a 201 would promise a Location that does not exist.
    //
    // An explicit ALLOWLIST, never `...result.stop`. The three counts are named because they MEAN different things
    // — interrupted, paused, asked-to-halt — and a spread would publish whatever core's ok arm gains tomorrow.
    case 'stop_activated':
      return jsonResponse(200, {
        stopId: result.stop.stopId,
        scope: result.stop.scope,
        heldCount: result.stop.heldCount,
        pausedCount: result.stop.pausedCount,
        stopRequestedCount: result.stop.stopRequestedCount,
      });
    // The status comes from the REASON (see STOP_REFUSAL_STATUS) because the eleven reasons do not share one, and
    // the reason itself travels so a caller can tell "already halted" from "that is not a scope".
    case 'stop_refused':
      return jsonResponse(STOP_REFUSAL_STATUS[result.reason], { error: 'stop_refused', reason: result.reason });
    // ── ACBP-API-013 — the understanding read and the metered interview pair ───────────────────────────────────
    // 200 carrying a NULL document when the interview has produced none — the G9 rule the strategy and roadmap
    // reads follow. A 404 here would assert the company has no understanding SURFACE, which is a different and
    // false statement, and it is how a UI shows an error page on a normal first visit.
    case 'understanding':
      // Named field by field, never spread: the allowlist rule from CDR-088 §2.1c. `superseded` is a SEPARATE
      // field from `confirmed` rather than a derived one, because they answer different questions — see
      // `readCurrentUnderstanding`.
      return jsonResponse(200, { document: result.understanding.document, confirmed: result.understanding.confirmed, superseded: result.understanding.superseded });
    // The verdict discriminator is preserved on the wire, with only that verdict's own payload beside it. A
    // client switching on `verdict` therefore cannot read a `clarification` off a `clear` answer, because one is
    // never sent. 200 and not 201: nothing is created at a new URL a client could then GET.
    case 'answer_evaluated':
      return jsonResponse(
        200,
        result.evaluation.verdict === 'clear'
          ? { verdict: 'clear', memoryItemId: result.evaluation.memoryItemId }
          : result.evaluation.verdict === 'vague'
            ? { verdict: 'vague', clarification: result.evaluation.clarification }
            : { verdict: 'contradictory', conflict: result.evaluation.conflict },
      );
    // `assumption: null` is a SUCCESS — the model declined to propose one (DISC-005). Mapping that to an error
    // would tell a founder something failed when the honest answer is that nothing could be assumed.
    case 'assumption_suggested':
      return jsonResponse(200, { assumption: result.assumption, memoryItemId: result.memoryItemId });
    case 'unauthenticated':
      return jsonResponse(401, genericErrorBody(401));
  }
}
