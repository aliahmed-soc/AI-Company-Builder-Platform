/*
 * ACBP-FE-018 — the account usage read's refusals. A server component.
 *
 * `usage:read` IS ACCOUNT-OWNER-ONLY, which makes `forbidden` here mean something different from the same status
 * on a company screen: an account VIEWER is refused by design, because a rollup spans every company in the
 * account and is therefore a statement about the account's total spend. Saying that policy out loud is not an
 * oracle — it is documented behaviour, and it is the difference between a founder thinking the platform is
 * broken and a founder understanding they are not the account owner.
 *
 * WHAT IS STILL OPAQUE: which of "not the owner", "not a member" and "no such account" applied. The request layer
 * drops that reason deliberately (`usage-request.ts:149-152`) so an address bar cannot enumerate account state,
 * and this component does not reconstruct it.
 *
 * AN UNCOMPUTED PERIOD NEVER REACHES HERE. `not_computed` is a SUCCESS carrying null (the G9 rule), rendered by
 * the ordinary screen as its own state. Routing it through this component would show an error page to a founder
 * whose account simply has not been projected yet.
 */

const COPY: Readonly<Record<string, { title: string; detail: string }>> = {
  unauthenticated: {
    title: 'You are signed out',
    detail: 'Reading an account’s usage requires a verified session. Sign in and this page will load.',
  },
  email_unverified: {
    title: 'Your email address is not verified',
    detail: 'You are signed in, but the platform requires a verified primary email before it reads account data. Verify the address on your account, then reload.',
  },
  forbidden: {
    title: 'This account’s usage is not visible to you',
    detail:
      'Usage spans every company in an account, so reading it is restricted to the account owner. The server does not distinguish between not being the owner, not being a member, and there being no such account — so this same response covers all three, and this page does not guess which applied.',
  },
  not_found: {
    title: 'The server found nothing at that address',
    detail:
      'This usually means no internal user record exists for this sign-in yet — a provisioning step that has not landed, which reloading in a moment often resolves.',
  },
  invalid_period: {
    title: 'That is not a period this platform can report on',
    detail: 'Usage is projected per calendar month, and the period asked for could not be read as one. Removing the period from the address will show the current month.',
  },
  unavailable: {
    title: 'Something this page depends on is down',
    detail: 'The usage projection could not be read because a dependency is unavailable. Nothing is wrong with your account and retrying is safe.',
  },
};

export function UsageRefusal({ status, retryAfterSeconds }: { status: string; retryAfterSeconds?: number }): React.JSX.Element {
  const known = COPY[status];
  const title = status === 'rate_limited' ? 'Too many requests' : (known?.title ?? 'Unexpected response');
  const detail =
    status === 'rate_limited'
      ? `A request ceiling refused this read.${retryAfterSeconds === undefined ? ' The server did not say how long to wait.' : ''}`
      : (known?.detail ?? `The server answered with a status this screen does not handle: ${status}. Nothing has been shown rather than guessing at what it meant.`);

  return (
    <>
      <div>
        <h1 className="cs-h1">Usage</h1>
      </div>
      <section className={`cs-refusal cs-refusal--${status}`} role="note" data-status={status}>
        <p className="cs-refusal-title">{title}</p>
        <p className="cs-refusal-detail">{detail}</p>
        {/*
         * THE SERVER'S NUMBER, VERBATIM — the `portfolio-screen.tsx` pattern, which is the other account-scoped
         * refusal in this console. The first draft of this file said "about N seconds", and softening a value the
         * server supplied is how a founder ends up retrying early and being refused again. It is presented as the
         * server's figure rather than as this screen's advice.
         */}
        {retryAfterSeconds !== undefined && (
          <p className="cs-refusal-meta">
            Server-supplied wait: <strong>{retryAfterSeconds}</strong> seconds. This is the value the server sent, not an estimate by this page.
          </p>
        )}
      </section>
    </>
  );
}
