/*
 * ACBP-FE-003 — the sign-up surface. See the sign-in page for why TWO of this row's criteria are Clerk's to
 * meet rather than this file's: the component owns its inputs, its labels, its validation and its errors, and
 * the app is never in the credential exchange. (The sign-in page also records why a third "disclosure" was
 * removed as false — the social-provider line is the row's *Explicit exclusions* cell, not a criterion, and
 * `appearance` can in fact reach those elements from code.)
 *
 * NO SIGN-IN LINK IS RENDERED HERE, for the same reason as on the sign-in page: Clerk's card footer already
 * carries one and the `(site)` header carries `<SignInButton />` for the signed-out visitor this page always
 * serves.
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
      </div>
    </main>
  );
}
