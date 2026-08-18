/*
 * ACBP-FE-010 — the memory read's refusals, each with its own words. A server component.
 *
 * NO `conflict` ENTRY, deliberately: the list read cannot produce a 409 (only the edit and delete writes
 * can), so copy for it would describe a response this component can never receive.
 *
 * `role="note"` rather than `role="alert"`: this is server-rendered and never changes after paint.
 */

const COPY: Readonly<Record<string, { title: string; detail: string }>> = {
  unauthenticated: {
    title: 'You are signed out',
    detail: 'Reading a company’s memory requires a verified session. Sign in and this page will load.',
  },
  email_unverified: {
    title: 'Your email address is not verified',
    detail: 'You are signed in, but the platform requires a verified primary email before it reads company data. Verify the address on your account, then reload.',
  },
  forbidden: {
    title: 'This memory is not visible to you',
    detail:
      'The server refused the read. Several situations produce an identical refusal here — the company may not exist, or it may exist and not be yours — and the response deliberately does not distinguish them, so that an address bar cannot be used to discover which companies exist.',
  },
  not_found: {
    title: 'The server found nothing at that address',
    detail: 'This usually means no internal user record exists for this sign-in yet — a provisioning step that has not landed, which reloading in a moment often resolves. The same response also covers a company this sign-in cannot resolve, and the server does not say which applied.',
  },
  unavailable: {
    title: 'Something this page depends on is down',
    detail: 'The memory list could not be read because a dependency is unavailable. Nothing is wrong with your company and retrying is safe.',
  },
};

export function MemoryRefusal({ status, retryAfterSeconds }: { status: string; retryAfterSeconds?: number }): React.JSX.Element {
  const known = COPY[status];
  const title = status === 'rate_limited' ? 'Too many requests' : (known?.title ?? 'Unexpected response');
  const detail =
    status === 'rate_limited'
      ? `A request ceiling refused this read.${retryAfterSeconds === undefined ? ' The server did not say how long to wait.' : ` It should succeed again in about ${String(retryAfterSeconds)} seconds.`}`
      : (known?.detail ?? `The server answered with a status this screen does not handle: ${status}. Nothing has been shown rather than guessing at what it meant.`);

  return (
    <>
      <div>
        <h1 className="cs-h1">Memory</h1>
      </div>
      <section className={`cs-refusal cs-refusal--${status}`} role="note" data-status={status}>
        <p className="cs-refusal-title">{title}</p>
        <p className="cs-refusal-detail">{detail}</p>
      </section>
    </>
  );
}
