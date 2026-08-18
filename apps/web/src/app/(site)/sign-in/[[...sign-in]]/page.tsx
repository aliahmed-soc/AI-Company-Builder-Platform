/*
 * ACBP-FE-003 — the sign-in surface.
 *
 * CLERK OWNS THE CREDENTIAL EXCHANGE ENTIRELY, and that is the load-bearing fact about this file. The
 * `<SignIn />` component renders its own inputs, its own labels, its own validation and its own error
 * states, inside its own DOM. This app never sees a password, never handles a failed exchange, and cannot
 * bind a label or an `aria-describedby` in that subtree.
 *
 * SO TWO OF THIS ROW'S CRITERIA ARE NOT THIS FILE'S TO MEET, and are disclosed rather than claimed:
 *   - "Labels bound to inputs; errors associated by aria-describedby" — Clerk's DOM, not ours. `SignInProps`
 *     exposes `appearance` (className/style per element) and no aria surface; owning the inputs would mean
 *     adopting `@clerk/elements`, which is not a dependency of this app.
 *   - "Bounded error envelope on a failed exchange" — the app is not in the exchange path. The surface it
 *     DOES own, `/auth-check`, already answers a bounded envelope for every arm.
 *
 * A THIRD DISCLOSURE WAS REMOVED BECAUSE IT WAS FALSE, and the correction is worth more than the sentence
 * was. It claimed that "No social-provider buttons" could not be enforced from here — but `appearance`
 * carries `socialButtonsRoot`, `socialButtons`, `socialButtonsIconButton` and `socialButtonsBlockButton`
 * elements, so `<SignIn appearance={{ elements: { socialButtonsRoot: { display: 'none' } } }} />` is exactly
 * the code-side control the sentence said did not exist. It is also NOT A CRITERION: it is the row's
 * *Explicit exclusions* cell — scope this ticket deliberately does not build, which needs no enforcer at all.
 * Hiding a provider with CSS would in any case not disable it; the Clerk dashboard is where a provider is
 * actually turned off, and that is an owner action (ACBP-P0-007).
 *
 * What this slice DOES own is the frame: the page around the component, which was previously a bare
 * `<main>` with no relationship to the rest of the product.
 *
 * NO SIGN-UP LINK IS RENDERED HERE. Clerk's own card already carries one in its footer (`signUpUrl` exists
 * precisely to fill it) and the `(site)` header carries `<SignUpButton />` for a signed-out visitor — which
 * is always the case on this page. A third one was three routes to the same place stacked vertically.
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
      </div>
    </main>
  );
}
