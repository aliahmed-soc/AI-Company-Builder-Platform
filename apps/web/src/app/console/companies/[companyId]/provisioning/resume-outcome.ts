/*
 * ACBP-FE-005 — interpreting `POST /api/companies/{id}/provisioning/resume`.
 *
 * THE SUCCESS ARM IS CALLED `ok`, NOT `advanced`, AND THAT IS THE POINT. Resume answers 200 with the CURRENT
 * `ProvisioningStatusDTO` (companies-request.ts maps `{status:'ok'}` to `{status:'provisioning'}`, served at
 * companies-http.ts:202-213) — and a run that was ALREADY COMPLETE takes the same path, because Phase A's
 * `already_completed` gate skips the step loop and still returns ok (core provisioning-service.ts:355-359).
 * So a 200 means "the server accepted the request and here is where the run stands", never "a step ran". The
 * screen learns whether anything moved by comparing the returned state, which is the only honest source.
 *
 * THE 409 CARRIES NO DISCRIMINATOR. Five distinct Phase A gates — company paused; all steps complete but the
 * company is in neither expected status; exhausted; a malformed checkpoint set; company active while steps are
 * incomplete (provisioning-service.ts:354,:360,:362,:363,:364) — all become one bodyless
 * `{"error":"conflict"}` (companies-http.ts:248-249). The copy therefore states that the server refused and
 * that it did not say which reason applied. Picking the most likely one would read as a diagnosis and would
 * be wrong four times in five.
 */
import type { ProvisioningStatusDTO } from '@acbp/contracts';

export type ResumeOutcome =
  | { readonly kind: 'ok'; readonly provisioning: ProvisioningStatusDTO; readonly detail: string }
  | { readonly kind: 'refused'; readonly detail: string }
  | { readonly kind: 'forbidden'; readonly detail: string }
  | { readonly kind: 'signed_out'; readonly detail: string }
  | { readonly kind: 'not_found'; readonly detail: string }
  | { readonly kind: 'rate_limited'; readonly detail: string; readonly retryAfterSeconds: number | null }
  | { readonly kind: 'unavailable'; readonly detail: string }
  | { readonly kind: 'error'; readonly detail: string };

function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (trimmed === '') return null; // `Number('')` is 0 — an empty header must never read as "retry now".
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** A 200 body is only usable if it is really the provisioning envelope; anything else is an error, not a win. */
function readProvisioning(body: string): ProvisioningStatusDTO | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const o = parsed as Record<string, unknown>;
    const looksRight =
      typeof o['companyId'] === 'string' &&
      typeof o['companyStatus'] === 'string' &&
      Array.isArray(o['steps']) &&
      typeof o['resumable'] === 'boolean' &&
      typeof o['exhausted'] === 'boolean' &&
      typeof o['completed'] === 'boolean';
    return looksRight ? (parsed as ProvisioningStatusDTO) : null;
  } catch {
    return null;
  }
}

export function interpretResumeResponse(status: number, body: string, retryAfterHeader: string | null): ResumeOutcome {
  if (status === 200) {
    const provisioning = readProvisioning(body);
    if (provisioning === null) {
      return { kind: 'error', detail: 'The server accepted the request but returned a reply this screen could not read. Reload to see the current setup state before trying again.' };
    }
    // Deliberately makes no claim about movement — see the header.
    return { kind: 'ok', provisioning, detail: 'The server accepted the request and returned the current setup state, shown above.' };
  }

  switch (status) {
    case 409:
      return {
        kind: 'refused',
        detail:
          'The server refused to resume and nothing changed. Several different situations produce an identical refusal here — among them a paused company, a step that has used its attempt limit, and a setup record that cannot be read consistently — and the response does not say which applied.',
      };
    case 403:
      return { kind: 'forbidden', detail: 'This sign-in is not permitted to resume setup for this company, and nothing changed.' };
    case 401:
      return { kind: 'signed_out', detail: 'Your session is not active, so nothing was resumed. Sign in and try again.' };
    case 404:
      return { kind: 'not_found', detail: 'No company was found for this sign-in at that address, and nothing was resumed.' };
    case 429:
      return { kind: 'rate_limited', detail: 'A request ceiling refused this resume, and nothing changed.', retryAfterSeconds: parseRetryAfter(retryAfterHeader) };
    case 503:
      return { kind: 'unavailable', detail: 'Something the setup depends on is down, so nothing was resumed. Retrying later is safe.' };
    case 500:
      // The route's own comment records a real guarantee: an unexpected mid-step error rolls that step back and
      // leaves the durable checkpoints untouched, so a later resume continues from the same place. Stating it
      // is honest BECAUSE the server states it — this screen is not inferring it.
      return { kind: 'error', detail: 'The server hit an unexpected error part-way through. That step was rolled back and the recorded progress is untouched, so resuming again continues from the same place.' };
    default:
      return { kind: 'error', detail: `The server answered with a status this screen does not handle: ${String(status)}. Nothing has been assumed about whether setup resumed — reload to see the current state.` };
  }
}
