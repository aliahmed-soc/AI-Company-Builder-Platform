/*
 * ACBP-FE-005 — turning the create POST's response into something the screen can say out loud.
 *
 * PURE ON PURPOSE, like `transition-outcome.ts` beside it: `(status, body, retryAfterHeader) -> outcome`.
 * The create form itself cannot be rendered in a test here (no Clerk keys in this environment, and the page
 * is a server component), so every arm the founder can hit has to be reachable from a unit test or it is
 * effectively unverified. That is the whole reason this file exists separately from the page.
 *
 * THE WIRE SHAPES ARE READ FROM THE ROUTE, NOT ASSUMED:
 *
 *   201 -> { company: { companyId, status, creationMode } }      companies-http.ts:117
 *   400 -> { error: <PublicErrorEnvelope> }  (validation)        companies-http.ts:180-181
 *   400 -> { error: 'bad_request' }          (unparseable body)  api/companies/route.ts:19-22
 *   401 -> { error: 'unauthorized' }                             companies-http.ts:268-269
 *   403 -> { error: 'forbidden' }                                companies-http.ts:254-255
 *   403 -> { error: 'email_unverified' }                         companies-http.ts:260-261
 *   404 -> { error: 'not_found' }                                companies-http.ts:256-257
 *   413 -> { error: 'payload_too_large' }                        api/companies/route.ts
 *   415 -> { error: 'unsupported_media_type' }                   api/companies/route.ts
 *   429 -> { error: 'rate_limited' } + Retry-After               companies-http.ts:262-267
 *   503 -> { error: 'unavailable' }                              companies-http.ts:258-259
 *   500 -> { error: 'internal_error' }                           companies-http.ts:105-111
 *
 * THERE IS NO 409 ARM, AND THAT ABSENCE IS DELIBERATE. `CreateCompanyResult` is exactly
 * `ok | forbidden | validation` (packages/core/src/company/company-service.ts:68-71), so create cannot
 * conflict. A `case 409:` here would be a branch handling something the server never sends — a claim no test
 * could falsify, which is the shape of defect ACBP-API-010 spent its length removing. A 409 therefore falls
 * through to `error`, which says honestly that the response was not one this screen knows how to read.
 */

/** `status` is the SERVER's lifecycle word, carried through untouched — this screen does not own that vocabulary. */
export type CreateOutcome =
  | {
      readonly kind: 'created';
      readonly companyId: string;
      readonly companyStatus: string;
      /**
       * True ONLY when the server said `active`. The create POST runs provisioning inline and awaited
       * (company-service.ts:192-211), so a 201 already carries the verdict: `active` means all six steps
       * finished inside the request, anything else means the run stopped partway and a resume is owed.
       * An unrecognised status reads as NOT finished — the conservative direction, because the cost of
       * wrongly claiming "ready" is a founder sent to a company that is not.
       */
      readonly provisioningFinishedInline: boolean;
    }
  /**
   * A 400 the DOMAIN produced. `error` is a `PublicErrorEnvelope` OBJECT, not a string
   * (companies-http.ts:180-181 returns `{ error: result.error }`; errors.ts:71,:147 defines the shape), and
   * its `message` is written by the server — `Unknown company creation mode.`, `A company name is required.`
   * or `The company description is too long.` (company-service.ts:92/96/102). It is carried through
   * VERBATIM: the server has already identified which of the three fields is wrong, and replacing that with
   * a general sentence about limits discards the only precise thing in the response.
   */
  | { readonly kind: 'invalid'; readonly code: string; readonly serverMessage: string; readonly detail: string }
  /** A 400 the ROUTE produced before the domain was reached — the body itself was unreadable. */
  | { readonly kind: 'malformed'; readonly detail: string }
  /** 415 — the content type was refused before the body was read (companies-http.ts:38-39). */
  | { readonly kind: 'malformed_media'; readonly detail: string }
  | { readonly kind: 'signed_out'; readonly detail: string }
  | { readonly kind: 'forbidden'; readonly detail: string }
  | { readonly kind: 'email_unverified'; readonly detail: string }
  | { readonly kind: 'no_user_record'; readonly detail: string }
  | { readonly kind: 'too_large'; readonly detail: string }
  | { readonly kind: 'rate_limited'; readonly detail: string; readonly retryAfterSeconds: number | null }
  | { readonly kind: 'unavailable'; readonly detail: string }
  | { readonly kind: 'error'; readonly detail: string };

/**
 * Retry-After, only when the server really sent a usable one. A fabricated 0 would say "retry now" — a lie.
 *
 * THE EMPTY-STRING GUARD IS LOAD-BEARING and was put here by a failing test, not by foresight: `Number('')`
 * is `0`, not `NaN`, so an empty header would otherwise parse as a perfectly valid "wait zero seconds". The
 * one input most likely to appear when a header is mishandled upstream is exactly the one that would have
 * produced the most confident wrong answer.
 */
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
  const o = readJson(body);
  const e = o?.['error'];
  return typeof e === 'string' ? e : '';
}

/**
 * The domain's validation envelope, when the 400 carries one. Returns null for a route-level 400, where
 * `error` is a plain string instead — the two 400s are genuinely different events and must not merge.
 */
function readEnvelope(body: string): { code: string; message: string } | null {
  const e = readJson(body)?.['error'];
  if (typeof e !== 'object' || e === null) return null;
  const o = e as Record<string, unknown>;
  const message = typeof o['message'] === 'string' ? o['message'] : '';
  const code = typeof o['code'] === 'string' ? o['code'] : '';
  return message === '' ? null : { code, message };
}

export function interpretCreateResponse(status: number, body: string, retryAfterHeader: string | null): CreateOutcome {
  if (status === 201) {
    const o = readJson(body);
    const company = o?.['company'];
    const c = typeof company === 'object' && company !== null ? (company as Record<string, unknown>) : null;
    const rawId = c?.['companyId'];
    const rawStatus = c?.['status'];
    const companyId = typeof rawId === 'string' ? rawId : '';
    const companyStatus = typeof rawStatus === 'string' ? rawStatus : '';
    // A 201 we cannot route on is an ERROR, not a success. Announcing "created" without an id would leave the
    // founder on a screen with nothing to poll and no way back to the company.
    if (companyId === '' || companyStatus === '') {
      return { kind: 'error', detail: 'The company was created, but the server did not return an id we can follow. Check the companies list before trying again — creating a second one is not safe.' };
    }
    return { kind: 'created', companyId, companyStatus, provisioningFinishedInline: companyStatus === 'active' };
  }

  const code = errorCode(body);

  switch (status) {
    case 400: {
      const envelope = readEnvelope(body);
      if (envelope !== null) {
        return {
          kind: 'invalid',
          code: envelope.code,
          serverMessage: envelope.message,
          // The screen adds only what the envelope does NOT say. `validateCreateCompanyInput` returns at the
          // FIRST failure (company-service.ts:91->94->98), so this is one problem, not a list, and fixing it
          // may reveal another. Saying so is honest; implying a complete report would not be.
          detail: 'The server refused the details and reports the first problem it found — correcting it may reveal another.',
        };
      }
      return { kind: 'malformed', detail: 'The server could not read the request this page sent, so nothing was created. That is a fault in this screen rather than in anything you typed.' };
    }
    case 401:
      return { kind: 'signed_out', detail: 'Your session is not active, so nothing was created. Sign in and the form will submit.' };
    case 403:
      return code === 'email_unverified'
        ? { kind: 'email_unverified', detail: 'Your email address is not verified. The platform requires a verified primary address before it creates a company. Verify it on your account, then submit again.' }
        : {
            kind: 'forbidden',
            // DELIBERATELY NAMES NO SINGLE CAUSE. A plain 403 covers at least being refused as not the
            // account owner, the platform user record no longer being active, and a request that failed the
            // same-origin check — and the body carries no discriminator. Picking one would hand a founder a
            // guess dressed as a diagnosis.
            detail: 'The server refused this creation and nothing was created. Several situations produce an identical refusal here — the account may not permit it, or the platform record behind this sign-in may no longer be active — and the response does not say which applied.',
          };
    case 404:
      return { kind: 'no_user_record', detail: 'You are authenticated, but no internal user record exists for this sign-in yet — usually a provisioning step that has not landed. Reloading in a moment often resolves it.' };
    case 413:
      // NOT the founder's fault, and the copy must not imply it is: the body cap is 16 KiB
      // (companies-http.ts:10) and this form's own limits cap it far below that.
      return { kind: 'too_large', detail: 'The server refused the request as too large. This screen limits a name to 200 characters and a description to 2000, well below the size that should trigger this, so it is a fault in this screen.' };
    case 415:
      return { kind: 'malformed_media', detail: 'The server refused the content type this page sent. Nothing was created, and this is a fault in this screen rather than in anything you typed.' };
    case 429:
      return { kind: 'rate_limited', detail: 'A request ceiling refused this creation. Nothing was created.', retryAfterSeconds: parseRetryAfter(retryAfterHeader) };
    case 503:
      return { kind: 'unavailable', detail: 'Something the creation depends on is down. Nothing was created, nothing is wrong with your account, and retrying is safe.' };
    default:
      // 500 and anything unlisted — including a 409, which create cannot produce (see the header).
      return { kind: 'error', detail: `The server answered with a status this screen does not handle: ${String(status)}. Nothing has been assumed about whether a company was created — check the companies list before submitting again.` };
  }
}
