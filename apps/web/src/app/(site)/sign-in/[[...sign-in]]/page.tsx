// ACBP-P1-001 — sign-in surface (Clerk-hosted <SignIn/> component; catch-all route so Clerk owns
// the sub-paths for MFA, verification, etc.). Loading and error UI are handled by the component.
import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  return (
    <main>
      <SignIn />
    </main>
  );
}
