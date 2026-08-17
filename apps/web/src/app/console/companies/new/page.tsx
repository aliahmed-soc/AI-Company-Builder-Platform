/*
 * ACBP-FE-005 — the company creation screen.
 *
 * A SERVER COMPONENT THAT READS NOTHING. Unlike the portfolio and company pages, there is no data to fetch
 * before the form is useful: creation is a write, and every arm of it is decided by the response. So this page
 * renders the form and gets out of the way.
 *
 * The form itself is a client component because the submission must be a same-origin `fetch` carrying a JSON
 * body — the reasoning, including why a native form POST cannot work here, is in `create-form.tsx`.
 */
import { CreateCompanyForm } from './create-form';

export const metadata = {
  title: 'New company — AI Company Builder',
  description: 'Create a company and run its setup steps.',
};

/*
 * Per-user and state-changing: never prerendered, never shared between callers. The root layout forces dynamic
 * rendering app-wide today, but that is an INTERIM hold whose future is explicitly undecided (CDR-083 §8 item
 * 9), so this page states its own requirement rather than inheriting one that may be lifted.
 */
export const dynamic = 'force-dynamic';

export default function NewCompanyPage(): React.JSX.Element {
  return (
    <>
      <div>
        <h1 className="cs-h1">Create a company</h1>
        <p className="cs-sub">
          The server creates the company and runs its six setup steps in the same request, so this can take a
          moment. The next screen shows exactly how far it got.
        </p>
      </div>

      <section className="cs-card" aria-labelledby="cs-create-h">
        <div className="cs-card-h">
          <h2 className="cs-card-t" id="cs-create-h">
            Company details
          </h2>
        </div>
        <CreateCompanyForm />
      </section>
    </>
  );
}
