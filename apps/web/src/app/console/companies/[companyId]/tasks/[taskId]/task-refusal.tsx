/*
 * ACBP-FE-015 — the task and run reads' refusals. A server component.
 *
 * `getTaskDetail` answers `ok` / `forbidden` / `not_found`. The `not_found` here is REAL and about the task —
 * unlike the strategy and approvals screens, where the same status could only be about the caller — so the copy
 * says so rather than blaming a provisioning step.
 *
 * A TASK WITH NO RUNS NEVER REACHES HERE. `listTaskRuns` returns a list and an empty list is a real answer:
 * the task has never been attempted. That is rendered as an ordinary empty state on the screen itself.
 */

const COPY: Readonly<Record<string, { title: string; detail: string }>> = {
  unauthenticated: {
    title: 'You are signed out',
    detail: 'Reading a task requires a verified session. Sign in and this page will load.',
  },
  email_unverified: {
    title: 'Your email address is not verified',
    detail: 'You are signed in, but the platform requires a verified primary email before it reads company data. Verify the address on your account, then reload.',
  },
  forbidden: {
    title: 'This task is not visible to you',
    detail:
      'The server refused the read. Several situations produce an identical refusal here — the company may not exist, or it may exist and not be yours — and the response deliberately does not distinguish them, so that an address bar cannot be used to discover which companies exist.',
  },
  not_found: {
    title: 'No such task',
    detail:
      'Unlike most screens in this console, a 404 here is REAL and about the task: "getTaskDetail" has its own not-found arm, so the server looked for this task in this company and did not find it. It may have been deleted, or the address may be wrong. The same status also covers a sign-in with no internal user record yet, and the server does not say which applied.',
  },
  unavailable: {
    title: 'Something this page depends on is down',
    detail: 'The task could not be read because a dependency is unavailable. Nothing is wrong with your company and retrying is safe.',
  },
};

export function TaskRefusal({ status, retryAfterSeconds }: { status: string; retryAfterSeconds?: number }): React.JSX.Element {
  const known = COPY[status];
  const title = status === 'rate_limited' ? 'Too many requests' : (known?.title ?? 'Unexpected response');
  const detail =
    status === 'rate_limited'
      ? `A request ceiling refused this read.${retryAfterSeconds === undefined ? ' The server did not say how long to wait.' : ` It should succeed again in about ${String(retryAfterSeconds)} seconds.`}`
      : (known?.detail ?? `The server answered with a status this screen does not handle: ${status}. Nothing has been shown rather than guessing at what it meant.`);

  return (
    <>
      <div>
        <h1 className="cs-h1">Task</h1>
      </div>
      <section className={`cs-refusal cs-refusal--${status}`} role="note" data-status={status}>
        <p className="cs-refusal-title">{title}</p>
        <p className="cs-refusal-detail">{detail}</p>
      </section>
    </>
  );
}
