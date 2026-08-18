/*
 * ACBP-FE-003 — the sign-in surface.
 *
 * CLERK OWNS THE CREDENTIAL EXCHANGE ENTIRELY, and that is the load-bearing fact about this file. The
 * `<SignIn />` component renders its own inputs, its own labels, its own validation and its own error
 * states, inside its own DOM. This app never sees a password, never handles a failed exchange, and cannot
 * bind a label or an `aria-describedby` in that subtree.
 *
 * SO THREE OF THIS ROW'S CRITERIA ARE NOT THIS FILE'S TO MEET, and are disclosed rather than claimed:
 *   - "Labels bound to inputs; errors associated by aria-describedby" — Clerk's DOM, not ours.
 *   - "Bounded error envelope on a failed exchange" — the app is not in the exchange path. The surface it
 *     DOES own, `/auth-check`, already answers a bounded envelope for every arm.
 *   - "No social-provider buttons until ACBP-P0-007 is wired" — a Clerk dashboard setting. No code here can
 *     enforce it, and a comment claiming it were enforced would name an enforcer that does not exist.
 *
 * What this slice DOES own is the frame: the page around the component, which was previously a bare
 * `<main>` with no relationship to the rest of the product.
 */
import { SignIn } from '@clerk/nextjs';

export const metadata = {
  title: 'Sign in — AI Company Builder',
  description: 'Sign in to the AI Company Builder console.',
};

export default function SignInPage(): React.JSX.Element {
  return (
    <main className="cs-auth">
      <div className="cs-auth-frame">
        <h1 className="cs-auth-title">Sign in</h1>
        {/* Single column at all widths, per the row: the frame sets a max width and centres it; it never
            switches to a multi-column layout, so there is no breakpoint at which that could regress. */}
        <SignIn />
        <p className="cs-auth-note">
          New here? <a href="/sign-up">Create an account</a>.
        </p>
      </div>
    </main>
  );
}