// ACBP-P1-001 — honest minimal auth entry page. No fabricated dashboard; it states the real auth
// state (resolved server-side from the verified session) and links to sign-in / sign-up and the
// server-side verification proof route.
import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';

export default async function Home() {
  const { userId } = await auth();
  return (
    <main>
      <h1>AI Company Builder Platform</h1>
      <p>Authentication boundary (ACBP-P1-001).</p>
      {userId ? (
        <>
          <p>You are signed in.</p>
          <p>
            <Link href="/auth-check">Verify your session server-side</Link>
          </p>
        </>
      ) : (
        <>
          <p>You are signed out.</p>
          <p>
            <Link href="/sign-in">Sign in</Link> &nbsp;·&nbsp; <Link href="/sign-up">Sign up</Link>
          </p>
        </>
      )}
    </main>
  );
}
