/*
 * ACBP-FE-013 — the strategy read's refusals. A server component.
 *
 * NOTE WHAT IS ABSENT: no `conflict`, no `validation`, and no arm for an empty generation.
 * `getStrategyForRequest` produces none of them — `LatestStrategyResult` has TWO arms, `ok` and `forbidden`,
 * and its payload is nullable. The remaining statuses here all come from ACTOR RESOLUTION, which runs before
 * the strategy read is attempted, so they are about the caller rather than about the strategy.
 *
 * AN ABSENT GENERATION NEVER REACHES THIS COMPONENT, and that is the point of CDR-087 §5.0 G9. It is a 200
 * carrying null — the honest first-visit empty state — and it is rendered by the panel as an ordinary screen.
 * Routing it here would put an error page in front of every founder who has not generated yet.
 */

const COPY: Readonly<Record<string, { title: string; detail: string }>> = {
  unauthenticated: {
    title: 'You are signed out',
    detail: 'Reading a company’s strategy requires a verified session. Sign in and this page will load.',
  },
  email_unverified: {
    title: 'Your email address is not verified',
    detail: 'You are signed in, but the platform requires a verified primary email before it reads company data. Verify the address on your account, then reload.',
  },
  forbidden: {
    title: 'This strategy is not visible to you',
    detail:
      'The server refused the read. Several situations produce an identical refusal here — the company may not exist, or it may exist and not be yours — and the response deliberately does not distinguish them, so that an address bar cannot be used to discover which companies exist.',
  },
  not_found: {
    title: 'The server found nothing at that address',
    detail:
      'On this screen a 404 can only be about YOU, not about the company: the strategy read itself has no not-found arm — it answers "ok" (with a possibly-null generation) or "forbidden" — so this status arrives from actor resolution, before the read is attempted. It means no internal user record exists for this sign-in yet, a provisioning step that has not landed, which reloading in a moment often resolves.',
  },
  unavailable: {
    title: 'Something this page depends on is down',
    detail: 'The strategy could not be read because a dependency is unavailable. Nothing is wrong with your company and retrying is safe.',
  },
};

export function StrategyRefusal({ status, retryAfterSeconds }: { status: string; retryAfterSeconds?: number }): React.JSX.Element {
  const known = COPY[status];
  const title = status === 'rate_limited' ? 'Too many requests' : (known?.title ?? 'Unexpected response');
  const detail =
    status === 'rate_limited'
      ? `A request ceiling refused this read.${retryAfterSeconds === undefined ? ' The server did not say how long to wait.' : ` It should succeed again in about ${String(retryAfterSeconds)} seconds.`}`
      : (known?.detail ?? `The server answered with a status this screen does not handle: ${status}. Nothing has been shown rather than guessing at what it meant.`);

  return (
    <>
      <div>
        <h1 className="cs-h1">Strategy</h1>
      </div>
      <section className={`cs-refusal cs-refusal--${status}`} role="note" data-status={status}>
        <p className="cs-refusal-title">{title}</p>
        <p className="cs-refusal-detail">{detail}</p>
      </section>
    </>
  );
}
