/*
 * ACBP-FE-003 — a guard over what the auth surfaces actually DO, which is not what the row assumes.
 *
 * THE ROW'S EVIDENCE LINE ASKS FOR "route tests for authenticated and unauthenticated redirects". This
 * application does not redirect. `proxy.ts` records the decision in its own words — clerkMiddleware()
 * "protects NOTHING automatically; every route is public until a handler opts in", and "enforcement for
 * protected surfaces is therefore performed explicitly" — and every console screen renders an honest
 * `unauthenticated` refusal instead of bouncing the caller away.
 *
 * That is a better behaviour than a redirect, for the reason this console repeats everywhere else: a
 * refusal can say WHICH of several things was wrong, and a redirect cannot say anything at all. But it
 * means a test of "the redirect" would be a test of a mechanism nobody built, so this file pins the
 * decision that replaced it. If someone later adds a silent bounce to /sign-in, this fails and they have to
 * choose it deliberately rather than drift into it.
 *
 * A STATIC SOURCE SCAN, like `secret-egress` and `route-inventory` beside it: the pages are server
 * components importing `@clerk/nextjs`, which cannot be rendered under this suite's node environment, and
 * there is no DOM harness anywhere in this repository.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from THIS FILE, not from `process.cwd()`. The suite runs from the repository root, so a
// cwd-relative path pointed at a `src` that does not exist there and the scan died before asserting
// anything — an absence-proving test that cannot even find the tree is worse than no test.
const APP_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function everySourceFile(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    // Directory entries are enumerated rather than globbed on purpose: a bracketed segment such as
    // `[[...sign-in]]` is read as a character class by a glob and silently matches nothing, which this
    // repository has been burned by repeatedly. A scan that matches nothing reads exactly like a clean one.
    if (statSync(full).isDirectory()) everySourceFile(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const SOURCES = everySourceFile(APP_SRC);

describe('the auth surfaces exist and are Clerk-owned', () => {
  it('scans a real, non-empty set of files', () => {
    // Self-test. Every assertion below is an ABSENCE, and an absence proven by a scan that walked nothing
    // is worthless — this is what makes the zero counts meaningful.
    expect(SOURCES.length).toBeGreaterThan(50);
    expect(SOURCES.some((f) => f.includes('proxy.ts'))).toBe(true);
  });

  it('renders Clerk components rather than hand-built credential forms', () => {
    // The app must never handle a password. The check is that these pages delegate — if a hand-rolled
    // <form> with a password input ever appears here, the row's "Clerk owns the credential exchange" stops
    // being true and this is where it should be noticed.
    const signIn = SOURCES.find((f) => f.includes('sign-in') && f.endsWith('page.tsx'));
    const signUp = SOURCES.find((f) => f.includes('sign-up') && f.endsWith('page.tsx'));
    expect(signIn, 'a sign-in page exists').toBeDefined();
    expect(signUp, 'a sign-up page exists').toBeDefined();
    const signInSrc = readFileSync(signIn as string, 'utf8');
    const signUpSrc = readFileSync(signUp as string, 'utf8');
    expect(signInSrc).toContain('<SignIn />');
    expect(signUpSrc).toContain('<SignUp />');
    for (const src of [signInSrc, signUpSrc]) {
      expect(src).not.toContain('type="password"');
      expect(src).not.toContain('<form');
    }
  });
});

describe('this application refuses rather than redirects', () => {
  it('contains NO redirect to the sign-in surface anywhere in the app source', () => {
    // The decision, pinned. `proxy.ts` states it and every console refusal component implements it by
    // carrying an `unauthenticated` arm with its own sentence.
    const offenders = SOURCES.filter((f) => {
      const src = readFileSync(f, 'utf8');
      // Comments and test fixtures legitimately mention the words; what is forbidden is a real call.
      return /\bredirect\s*\(\s*['"`]\/sign-in/.test(src) || /redirectToSignIn\s*\(/.test(src);
    }).map((f) => f.replace(APP_SRC, ''));
    expect(offenders, 'a redirect would replace an honest refusal with a bounce that explains nothing').toEqual([]);
  });

  it('the offender detector is not vacuous', () => {
    // Proves the pattern above can fire, so its empty result means something. Two synthetic positives, one
    // per branch, checked directly rather than by trusting the regex to be obviously correct.
    expect(/\bredirect\s*\(\s*['"`]\/sign-in/.test("redirect('/sign-in')")).toBe(true);
    expect(/redirectToSignIn\s*\(/.test('return redirectToSignIn();')).toBe(true);
    expect(/\bredirect\s*\(\s*['"`]\/sign-in/.test("// we deliberately do not redirect to /sign-in")).toBe(false);
  });

  it('every console refusal surface carries an unauthenticated arm — the mechanism that replaced the redirect', () => {
    const refusals = SOURCES.filter((f) => /refusal\.tsx$/.test(f));
    expect(refusals.length, 'there are refusal components to check').toBeGreaterThan(0);
    for (const f of refusals) {
      expect(readFileSync(f, 'utf8'), `${f.replace(APP_SRC, '')} handles an unauthenticated caller`).toContain('unauthenticated');
    }
  });
});
