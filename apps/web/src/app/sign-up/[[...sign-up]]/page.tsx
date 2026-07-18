// ACBP-P1-001 — sign-up surface (Clerk-hosted <SignUp/> component; catch-all route).
import { SignUp } from '@clerk/nextjs';

export default function SignUpPage() {
  return (
    <main>
      <SignUp />
    </main>
  );
}
