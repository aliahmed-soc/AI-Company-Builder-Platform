// ACBP-P1-010 — safe HTTP mapping + bounded body parsing for the companies routes (apps/web).
//
// Keeps Next types out of the domain and never leaks internals. Bodies are size-capped and JSON-typed; only
// the expected keys survive parsing. Field-level validation is the domain's job (@acbp/core). A denial is the
// same opaque 403 regardless of cause (not a member vs not allowed) — no oracle.
import { isJsonContentType, genericErrorBody } from '../webhooks/http.js';
import { readLimitedRawBody, type RawBodyRequest } from '../webhooks/raw-body.js';
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
    // 200, not 201. Neither call creates a resource at a new URL the client can then GET — the selection and the
    // decision are read back through the company's strategy surface — so 201 would promise a Location that does
    // not exist. Recorded here rather than defaulted (CDR-087 §5).
    case 'strategy_selected':
      return jsonResponse(200, { selection: result.selection });
    case 'decision_recorded':
      return jsonResponse(200, { decision: result.decision });
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
      // CDR-008 §8's request ceiling (ACBP-P7-013; CDR-082). 429 with `Retry-After`, and the body carries the
      // SAME opaque envelope as every other refusal — no bucket balance, no limit value, no scope name. A
      // response that told a caller which ceiling they hit and how much of it remains is a measurement tool for
      // finding the cheapest way to stay just under it.
      return rateLimitedResponse(result.retryAfterSeconds);
    case 'unauthenticated':
      return jsonResponse(401, genericErrorBody(401));
  }
}
