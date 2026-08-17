/*
 * ACBP-FE-010 — interpreting the three memory verbs the browser uses.
 *
 * ONE MODULE FOR ALL THREE, deliberately. The interview slice used a file per verb, and an independent
 * review of it found that the empty-string guard in `parseRetryAfter` is the kind of thing that gets
 * re-derived slightly wrong each time it is copied — `Number('')` is `0`, so an unguarded parse tells a
 * rate-limited founder to retry immediately. Three copies would be three chances to lose it. The shape
 * readers are shared for the same reason; the ARMS stay separate per verb, because the verbs genuinely
 * differ (see below).
 *
 * THE WIRE SHAPES ARE READ FROM THE ROUTES, NOT ASSUMED:
 *
 *   GET    list  200 -> { items: MemoryItemDTO[] }        companies-http.ts (memory_list arm)
 *   PATCH  item  200 -> { item: MemoryItemDTO }           (memory_edited arm)
 *   DELETE item  200 -> { memoryItemId: string }          (memory_deleted arm — nothing else is leaked)
 *   400 -> { error: <PublicErrorEnvelope> } (domain) | { error: 'bad_request' } (route, pre-domain)
 *   401 / 403 forbidden / 403 email_unverified / 404 / 409 / 413 / 415 / 429 +Retry-After / 503 / 500
 *
 * TWO ARMS ARE COUNTER-INTUITIVE AND BOTH ARE LOAD-BEARING:
 *
 *   A SUCCESSFUL EDIT RETURNS A DIFFERENT ID THAN THE URL IT WAS SENT TO. Editing supersedes rather than
 *   mutates: the server inserts a new row and points the old one's `superseded_by` at it, so the 200 body
 *   describes the NEW item. Comparing the returned id to the requested one and reporting a mismatch would
 *   flag every successful edit as broken. The new id is surfaced instead, because the caller needs it.
 *
 *   THE 409 NAMES NO CAUSE, AND MUST NOT. On both edit and delete a bare `{"error":"conflict"}` covers at
 *   least three distinct states — the item was already deleted, it is a superseded historical version, or a
 *   concurrent write won the race. The body carries no discriminator, and a follow-up read cannot settle it
 *   either, because a deleted item answers 404 rather than reporting itself deleted. The copy therefore
 *   says the state changed and asks for a reload, which is true in all three cases.
 *
 * DELETE HAS NO 413 OR 415 ARM. It sends no body, so neither status is reachable; a branch for them would
 * handle something the server cannot send. They fall through to the honest default.
 */
import type { MemoryItemDTO } from '@acbp/contracts';

type Refusal =
  | { readonly kind: 'invalid'; readonly code: string; readonly serverMessage: string; readonly detail: string }
  | { readonly kind: 'malformed'; readonly detail: string }
  | { readonly kind: 'malformed_media'; readonly detail: string }
  | { readonly kind: 'signed_out'; readonly detail: string }
  | { readonly kind: 'forbidden'; readonly detail: string }
  | { readonly kind: 'email_unverified'; readonly detail: string }
  | { readonly kind: 'not_found'; readonly detail: string }
  | { readonly kind: 'conflict'; readonly detail: string }
  | { readonly kind: 'too_large'; readonly detail: string }
  | { readonly kind: 'rate_limited'; readonly detail: string; readonly retryAfterSeconds: number | null }
  | { readonly kind: 'unavailable'; readonly detail: string }
  | { readonly kind: 'error'; readonly detail: string };

export type ListOutcome = { readonly kind: 'items'; readonly items: readonly MemoryItemDTO[]; readonly detail: string } | Refusal;
export type EditOutcome = { readonly kind: 'saved'; readonly item: MemoryItemDTO; readonly detail: string } | Refusal;
export type DeleteOutcome = { readonly kind: 'deleted'; readonly memoryItemId: string; readonly detail: string } | Refusal;

/** `Number('')` is 0, so an empty header would parse as a valid "wait zero seconds". See the header. */
function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function readJson(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function errorCode(body: string): string {
  const e = readJson(body)?.['error'];
  return typeof e === 'string' ? e : '';
}

/** The domain envelope, or null when the 400 was the route's string form. Keeps the two 400s apart. */
function readEnvelope(body: string): { code: string; message: string } | null {
  const e = readJson(body)?.['error'];
  if (typeof e !== 'object' || e === null) return null;
  const o = e as Record<string, unknown>;
  const message = typeof o['message'] === 'string' ? o['message'] : '';
  const code = typeof o['code'] === 'string' ? o['code'] : '';
  return message === '' ? null : { code, message };
}

/** A value is only a memory item if it really carries the DTO's shape; a partial one is not rendered. */
function asItem(value: unknown): MemoryItemDTO | null {
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  const confidence = o['confidence'];
  const supersededBy = o['supersededBy'];
  const looksRight =
    typeof o['memoryItemId'] === 'string' &&
    typeof o['type'] === 'string' &&
    typeof o['content'] === 'string' &&
    typeof o['sourceType'] === 'string' &&
    typeof o['sourceRef'] === 'string' &&
    (typeof confidence === 'number' || confidence === null) &&
    typeof o['confirmationState'] === 'string' &&
    (typeof supersededBy === 'string' || supersededBy === null) &&
    typeof o['createdAt'] === 'string';
  return looksRight ? (value as unknown as MemoryItemDTO) : null;
}

/** Every refusal shared by all three verbs. `noun` names what did not happen, so each arm can say it. */
function refusalFor(status: number, body: string, retryAfterHeader: string | null, noun: string): Refusal {
  const code = errorCode(body);
  switch (status) {
    case 400: {
      const envelope = readEnvelope(body);
      if (envelope !== null) {
        return {
          kind: 'invalid',
          code: envelope.code,
          // VERBATIM. Note the envelope names the problem but NOT which field failed — the field list is
          // internal metadata that never reaches the wire — so the screen cannot highlight an input.
          serverMessage: envelope.message,
          detail: 'The server judged this and reports the first problem it found. It does not say which field was at fault.',
        };
      }
      return { kind: 'malformed', detail: `The server could not read what this screen sent, so ${noun}. That is a fault in this screen rather than in anything you typed.` };
    }
    case 401:
      return { kind: 'signed_out', detail: `Your session is not active, so ${noun}. Sign in and try again.` };
    case 403:
      return code === 'email_unverified'
        ? { kind: 'email_unverified', detail: `Your email address is not verified, so ${noun}. The platform requires a verified primary address first.` }
        : { kind: 'forbidden', detail: `The server refused this and ${noun}. Editing and deleting are limited to the account owner, and several other situations produce an identical refusal — the response does not say which applied.` };
    case 404:
      return { kind: 'not_found', detail: `The server found nothing at that address, so ${noun}. A deleted item also answers this way, so the item may simply be gone. Reload the list to see what is there.` };
    case 409:
      // Names no cause on purpose. See the header.
      return { kind: 'conflict', detail: `The server refused because this item's state has changed, and ${noun}. It does not say which change — the item may have been deleted, replaced by a newer version, or altered by another request at the same moment. Reload the list.` };
    case 413:
      return { kind: 'too_large', detail: `The server refused the request as too large, so ${noun}. Its size limit is measured in bytes as well as characters, so text in a non-Latin script can exceed it before the character count does.` };
    case 415:
      return { kind: 'malformed_media', detail: `The server refused the content type this screen sent, so ${noun}. That is a fault in this screen.` };
    case 429:
      return { kind: 'rate_limited', detail: `A request ceiling refused this, and ${noun}.`, retryAfterSeconds: parseRetryAfter(retryAfterHeader) };
    case 503:
      return { kind: 'unavailable', detail: `Something this depends on is down, so ${noun}. Nothing is wrong with your account, and retrying is safe.` };
    default:
      return { kind: 'error', detail: `The server answered with a status this screen does not handle: ${String(status)}. Nothing has been assumed about whether ${noun} — reload the list to see the current state.` };
  }
}

export function interpretListResponse(status: number, body: string, retryAfterHeader: string | null): ListOutcome {
  if (status === 200) {
    const raw = readJson(body)?.['items'];
    if (!Array.isArray(raw)) {
      // NOT an empty list. An unreadable 200 rendered as zero items would show an absence the server never
      // stated — the defect an independent review found in the interview screen.
      return { kind: 'error', detail: 'The server answered but returned a reply this screen could not read, so nothing is listed. That is not the same as there being no memory items — reload to try again.' };
    }
    const items = raw.map(asItem).filter((i): i is MemoryItemDTO => i !== null);
    return { kind: 'items', items, detail: 'The list below is what the server returned.' };
  }
  return refusalFor(status, body, retryAfterHeader, 'nothing could be listed');
}

export function interpretEditResponse(status: number, body: string, retryAfterHeader: string | null): EditOutcome {
  if (status === 200) {
    const item = asItem(readJson(body)?.['item']);
    if (item === null) {
      return { kind: 'error', detail: 'The server accepted the edit but returned a reply this screen could not read. Reload the list to see what is actually stored before editing again.' };
    }
    // The id differs from the one edited, and that is correct — see the header.
    return { kind: 'saved', item, detail: 'Saved as a new version. The previous version is kept and stays visible in the list.' };
  }
  return refusalFor(status, body, retryAfterHeader, 'nothing was changed');
}

export function interpretDeleteResponse(status: number, body: string, retryAfterHeader: string | null): DeleteOutcome {
  if (status === 200) {
    const id = readJson(body)?.['memoryItemId'];
    if (typeof id !== 'string' || id === '') {
      return { kind: 'error', detail: 'The server answered but did not name the item it removed. Reload the list to see what is actually stored.' };
    }
    return { kind: 'deleted', memoryItemId: id, detail: 'Removed from this browser. The record is retained for the audit trail and still appears in your data export.' };
  }
  // 413 and 415 are unreachable on a bodiless DELETE and fall through to the default (see the header).
  if (status === 413 || status === 415) {
    return { kind: 'error', detail: `The server answered with a status this screen does not handle: ${String(status)}. Nothing has been assumed about whether the item was removed — reload the list to see the current state.` };
  }
  return refusalFor(status, body, retryAfterHeader, 'nothing was removed');
}
