/*
 * ACBP-FE-007 — the interview read's refusals, each with its own words.
 *
 * A server component: these arms are decided before the page renders.
 *
 * `not_found` IS DELIBERATELY ABSENT FROM THIS TABLE. On the interview read a 404 is the ordinary
 * first-visit state — no session row exists until one is started — so the page handles it as an empty state
 * with a start control rather than routing it here. Adding a "not found" refusal box would turn every
 * founder's first visit into an error screen.
 *
 * `role="note"` rather than `role="alert"`: this is server-rendered and never changes after paint, and an
 * alert announces something that just happened. The alert role belongs on the post-submit outcome.
 */

const COPY: Readonly<Record<string, { title: string; detail: string }>> = {
  unauthenticated: {
    title: 'You are signed out',
    detail: 'Reading a company’s interview requires a verified session. Sign in and this page will load.',
  },
  email_unverified: {
    title: 'Your email address is not verified',
    detail: 'You are signed in, but the platform requires a verified primary email before it reads company data. Verify the address on your account, then reload.',
  },
  forbidden: {
    title: 'This interview is not visible to you',
    detail:
      'The server refused the read. Several situations produce an identical refusal here — the company may not exist, or it may exist and not be yours — and the response deliberately does not distinguish them, so that an address bar cannot be used to discover which companies exist.',
  },
  unavailable: {
    title: 'Something this page depends on is down',
    detail: 'The interview could not be read because a dependency is unavailable. Nothing is wrong with your company and retrying is safe.',
  },
  conflict: {
    title: 'The server refused this read',
    detail: 'The server reported a conflict and did not say which of several possible reasons applied. Reloading in a moment often resolves it.',
  },
};

export function InterviewRefusal({ status, retryAfterSeconds }: { status: string; retryAfterSeconds?: number }): React.JSX.Element {
  const known = COPY[status];
  const title = status === 'rate_limited' ? 'Too many requests' : (known?.title ?? 'Unexpected response');
  const detail =
    status === 'rate_limited'
      ? `A request ceiling refused this read.${retryAfterSeconds === undefined ? ' The server did not say how long to wait.' : ` It should succeed again in about ${String(retryAfterSeconds)} seconds.`}`
      : (known?.detail ?? `The server answered with a status this screen does not handle: ${status}. Nothing has been shown rather than guessing at what it meant.`);

  return (
    <>
      <div>
        <h1 className="cs-h1">Interview</h1>
      </div>
      <section className={`cs-refusal cs-refusal--${status}`} role="note" data-status={status}>
        <p className="cs-refusal-title">{title}</p>
        <p className="cs-refusal-detail">{detail}</p>
      </section>
    </>
  );
}
