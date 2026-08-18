/*
 * ACBP-FE-003 — the sign-up surface. See the sign-in page for why three of this row's criteria are
 * Clerk's to meet rather than this file's: the component owns its inputs, its labels, its validation and
 * its errors, and the app is never in the credential exchange.
 */
import { SignUp } from '@clerk/nextjs';

export const metadata = {
  title: 'Create an account — AI Company Builder',
  description: 'Create an account for the AI Company Builder console.',
};

export default function SignUpPage(): React.JSX.Element {
  return (
    <main className="cs-auth">
      <div className="cs-auth-frame">
        <h1 className="cs-auth-title">Create an account</h1>
        <SignUp />
        <p className="cs-auth-note">
          Already have one? <a href="/sign-in">Sign in</a>.
        </p>
      </div>
    </main>
  );
}