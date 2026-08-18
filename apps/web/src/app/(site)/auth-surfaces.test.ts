/*
 * ACBP-FE-003 — a guard over what the auth surfaces actually DO, which is not what the row assumes.
 *
 * THE ROW'S EVIDENCE LINE ASKS FOR "route tests for authenticated and unauthenticated redirects". This
 * application does not redirect. `proxy.ts` records the decision in its own words — clerkMiddleware()
 * "protects NOTHING automatically; every route is public until a handler opts in", and "enforcement for
 * protected surfaces is therefore performed explicitly" — and every console screen THAT READS REAL DATA
 * renders an honest refusal carrying an `unauthenticated` arm instead of bouncing the caller away.
 *
 * THAT QUALIFIER IS A CORRECTION, NOT A HEDGE. The first version of this file said "every console screen",
 * and an independent review found `/console` itself — the landing page — has no authorization check on the
 * page OR on its layout, and renders to anyone. It is an ENTIRELY MOCK screen (`MOCK_STATS`,
 * `MOCK_APPROVALS`, `MOCK_ACTIVITY`) that says so on screen, so nothing real leaks; but the sentence claimed
 * a property the code did not have, which is the defect class this repository keeps paying for. The test
 * `the console landing page is still mock` below pins the real state, so the day that page gains a real read
 * it fails here rather than silently becoming the counterexample to its own guard.
 *
 * Refusing rather than redirecting is the better behaviour, for the reason this console repeats everywhere
 * else: a refusal can say WHICH of several things was wrong, and a redirect cannot say anything at all. But
 * it means a test of "the redirect" would test a mechanism nobody built, so this file pins the decision that
 * replaced it — and pins it against the idioms someone would ACTUALLY reach for, not just the one spelling
 * the first version happened to think of.
 *
 * A STATIC SOURCE SCAN, like `secret-egress` and `route-inventory` beside it: the pages are server
 * components importing `@clerk/nextjs`, which cannot be rendered under this suite's node environment, and
 * there is no DOM harness anywhere in this repository.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from THIS FILE, not from `process.cwd()`. The suite runs from the repository root, so a
// cwd-relative path pointed at a `src` that does not exist there and the scan died before asserting
// anything — an absence-proving test that cannot even find the tree is worse than no test.
const HERE = dirname(fileURLToPath(import.meta.url));
const APP_SRC = join(HERE, '..', '..');
const WEB_ROOT = join(APP_SRC, '..');

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

/**
 * CONFIG FILES OUTSIDE `src` ARE PART OF THE SCAN, because one of them can redirect without any application
 * code changing at all. A review found `next.config.ts` — which can declare `async redirects()` — sitting
 * entirely outside the original scan root, so the single highest-leverage place to add a silent bounce was
 * the one place the guard could not see.
 */
const CONFIG_FILES = ['next.config.ts', 'next.config.mjs', 'next.config.js'].map((f) => join(WEB_ROOT, f)).filter((f) => existsSync(f));

const SOURCES = [...everySourceFile(APP_SRC), ...CONFIG_FILES];

/**
 * Strip comments so the scan reads CODE, not prose about code.
 *
 * The first version claimed in a comment that it told "comments and test fixtures" apart from real calls. It
 * did not — it had no comment awareness at all, and its negative control passed only because that particular
 * sentence happened to omit a parenthesis. An ordinary line like `// never call redirect('/sign-in') here`
 * would have failed the suite and named a file containing no redirect. Now the claim has an enforcer.
 *
 * `(?<!:)` keeps `https://…` from being read as the start of a line comment.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(?<!:)\/\/[^\n]*/g, ' ');
}

interface Surface {
  readonly path: string;
  readonly rel: string;
  readonly code: string;
}

const SURFACES: readonly Surface[] = SOURCES.map((path) => ({
  path,
  rel: path.replace(APP_SRC, '').replace(WEB_ROOT, ''),
  code: stripComments(readFileSync(path, 'utf8')),
}));

/**
 * The idioms that actually produce a bounce to the sign-in surface in this stack.
 *
 * A review demonstrated that the original pair of patterns caught exactly ONE spelling —
 * `redirect('/sign-in')` written inline with a string literal — which is the spelling nobody reaching for a
 * Clerk redirect would use, because Clerk ships `auth.protect()` and `<RedirectToSignIn />` for the job. Two
 * of the misses were already idioms present in this repository. Each entry below names why it is here.
 */
const REDIRECT_IDIOMS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  // Any navigation call whose argument mentions the sign-in path — literal, template or concatenated.
  // `[^)]*` spans the argument list, so `redirect(`${base}/sign-in`)` and `redirect("/sign-in?x=1")` match.
  { name: "redirect(...'/sign-in'...)", pattern: /\bredirect\s*\(\s*[^)]*\/sign-in/ },
  { name: "permanentRedirect(...'/sign-in'...)", pattern: /\bpermanentRedirect\s*\(\s*[^)]*\/sign-in/ },
  // ALREADY THIS REPO'S IDIOM: `console/companies/new/create-form.tsx` navigates with `router.push`.
  { name: "router.push(...'/sign-in'...)", pattern: /\.\s*push\s*\(\s*[^)]*\/sign-in/ },
  { name: "router.replace(...'/sign-in'...)", pattern: /\.\s*replace\s*\(\s*[^)]*\/sign-in/ },
  { name: "NextResponse.redirect(...'/sign-in'...)", pattern: /NextResponse\s*\.\s*redirect\s*\(\s*[^)]*\/sign-in/ },
  // These three name NO path at all — they resolve the sign-in URL from Clerk's own configuration, so a
  // path-based pattern can never see them. They are the most likely way this decision would actually be
  // reversed, which is why the original guard's answer to "would it catch a real change" was no.
  { name: 'redirectToSignIn()', pattern: /\bredirectToSignIn\s*\(/ },
  { name: '<RedirectToSignIn />', pattern: /<\s*RedirectToSignIn\b/ },
  { name: 'auth.protect() / auth().protect()', pattern: /\bauth\s*(?:\(\s*\))?\s*\.\s*protect\s*\(/ },
  // A config-level redirect changes no application code at all.
  { name: 'next.config redirects() → /sign-in', pattern: /destination\s*:\s*['"`][^'"`]*\/sign-in/ },
];

describe('the scan itself is sound', () => {
  it('walks a real, non-empty tree and reaches the files that matter', () => {
    // Self-test. Every offender assertion below is an ABSENCE, and an absence proven by a scan that walked
    // nothing is worthless. The named files are the ones a reader would expect to be covered.
    expect(SURFACES.length).toBeGreaterThan(50);
    expect(SURFACES.some((s) => s.path.endsWith('proxy.ts')), 'the middleware is scanned').toBe(true);
    expect(SURFACES.some((s) => s.path.includes('next.config')), 'the Next config is scanned').toBe(true);
    expect(SURFACES.some((s) => s.path.includes('console')), 'the console tree is scanned').toBe(true);
  });

  it('the comment stripper removes comments and keeps code', () => {
    // Its own self-test, because the offender scan's correctness now DEPENDS on it: a stripper that removed
    // too much would silently hide a real redirect, which is the failure mode that matters.
    expect(stripComments("// redirect('/sign-in')\nconst a = 1;")).not.toContain('/sign-in');
    expect(stripComments("/* redirect('/sign-in') */ const a = 1;")).not.toContain('/sign-in');
    expect(stripComments("const a = 1; // note")).toContain('const a = 1;');
    expect(stripComments("redirect('/sign-in');"), 'real code survives').toContain('/sign-in');
    // A URL is not a line comment.
    expect(stripComments("const u = 'https://example.test/x';")).toContain('https://example.test/x');
  });

  it('every offender pattern can fire, so an empty result means something', () => {
    // One synthetic positive per idiom. A pattern that cannot match reads exactly like a clean codebase.
    const samples: Record<string, string> = {
      "redirect(...'/sign-in'...)": "redirect('/sign-in')",
      "permanentRedirect(...'/sign-in'...)": "permanentRedirect('/sign-in')",
      "router.push(...'/sign-in'...)": "router.push('/sign-in')",
      "router.replace(...'/sign-in'...)": "router.replace('/sign-in')",
      "NextResponse.redirect(...'/sign-in'...)": "NextResponse.redirect(new URL('/sign-in', req.url))",
      'redirectToSignIn()': 'return redirectToSignIn();',
      '<RedirectToSignIn />': 'if (!userId) return <RedirectToSignIn />;',
      'auth.protect() / auth().protect()': 'await auth.protect();',
      'next.config redirects() → /sign-in': "{ source: '/console/:path*', destination: '/sign-in', permanent: false }",
    };
    for (const idiom of REDIRECT_IDIOMS) {
      const sample = samples[idiom.name];
      expect(sample, `a sample exists for ${idiom.name}`).toBeDefined();
      expect(idiom.pattern.test(sample as string), `${idiom.name} matches its own sample`).toBe(true);
    }
    expect(Object.keys(samples)).toHaveLength(REDIRECT_IDIOMS.length);
  });

  it('the alternative spelling of auth().protect() is caught too', () => {
    const p = REDIRECT_IDIOMS.find((i) => i.name.startsWith('auth.protect'))?.pattern;
    expect(p?.test('await auth().protect();')).toBe(true);
  });

  it('does NOT flag an ordinary link to the sign-in page, or a comment about one', () => {
    // A link a visitor CHOOSES to click is not a bounce, and `(site)/page.tsx` legitimately renders one. If
    // these matched, the guard would fail on correct code and teach the next reader to delete it.
    const innocent = ['<Link href="/sign-in">Sign in</Link>', "// we deliberately never redirect('/sign-in')", '/* router.push("/sign-in") is forbidden here */'];
    for (const src of innocent) {
      const code = stripComments(src);
      for (const idiom of REDIRECT_IDIOMS) {
        expect(idiom.pattern.test(code), `${JSON.stringify(src)} must not match ${idiom.name}`).toBe(false);
      }
    }
  });
});

describe('the auth surfaces exist and are Clerk-owned', () => {
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
  it('contains NO bounce to the sign-in surface, by ANY of the idioms this stack offers', () => {
    const offenders: string[] = [];
    for (const surface of SURFACES) {
      for (const idiom of REDIRECT_IDIOMS) {
        if (idiom.pattern.test(surface.code)) offenders.push(`${surface.rel} (${idiom.name})`);
      }
    }
    expect(offenders, 'a redirect would replace an honest refusal with a bounce that explains nothing').toEqual([]);
  });
});

describe('the refusal arms that replaced the redirect', () => {
  /*
   * THE SWEEP IS KEYED ON BEHAVIOUR, NOT ON A FILENAME. The first version matched `*-refusal.tsx` and so
   * checked four files while its own name said "every" — a review found the Companies list and the Company
   * page keep their refusal copy in `.ts` view builders (`portfolio-view.ts`, `company-view.ts`) with an
   * inline `Refusal` component, entirely outside the sweep. Deleting their `unauthenticated` case left the
   * suite green.
   *
   * Handling `forbidden` is the marker instead: any surface that maps one refusal status maps the whole set,
   * so every present and FUTURE refusal surface is picked up without anyone remembering to add it here. It is
   * matched in three spellings because this console genuinely uses all three — a quoted status, a bare object
   * key in a COPY table, and a `case 403:` in a status interpreter.
   */
  const HANDLES_FORBIDDEN = /'forbidden'|"forbidden"|(?:^|\n)\s*forbidden\s*:|case\s+403\s*:/;
  const refusalSurfaces = SURFACES.filter((s) => s.path.includes(join('app', 'console')) && HANDLES_FORBIDDEN.test(s.code));

  it('finds the refusal surfaces at all, including the two that are not *-refusal.tsx', () => {
    expect(refusalSurfaces.length).toBeGreaterThanOrEqual(4);
    expect(refusalSurfaces.some((s) => s.path.endsWith('portfolio-view.ts')), 'the portfolio view is swept').toBe(true);
    expect(refusalSurfaces.some((s) => s.path.endsWith('company-view.ts')), 'the company view is swept').toBe(true);
    expect(refusalSurfaces.some((s) => /refusal\.tsx$/.test(s.path)), 'the refusal components are swept').toBe(true);
  });

  it('every refusal surface handles an unauthenticated caller IN CODE, not in a comment', () => {
    /*
     * `.toContain('unauthenticated')` ON RAW TEXT WAS VACUOUS, and a review proved it on a real file:
     * `provisioning-refusal.tsx` names all six statuses in its header comment, so deleting the actual
     * `COPY.unauthenticated` arm left the assertion satisfied while a signed-out founder fell through to
     * "The server answered with a status this screen does not handle: unauthenticated". The mutation that
     * supposedly proved this guard had been run against a different file, where the word appears only as a
     * key. Comments are stripped now and the token must appear as a quoted status, an object key, or a case.
     *
     * THREE NAMES FOR ONE STATE, and the guard accepts all three because the console really does use all
     * three: the refusal components key on `unauthenticated`, `create-outcome.ts` returns `signed_out` from
     * `case 401:`, and one comment calls the wire value `unauthorized`. Widening this assertion is what
     * surfaced that — it is inconsistent vocabulary, not a missing arm, and pinning the BEHAVIOUR rather
     * than one spelling is what keeps this test about whether a signed-out caller is answered at all.
     */
    const HANDLES_SIGNED_OUT = /'unauthenticated'|"unauthenticated"|(?:^|\n)\s*unauthenticated\s*:|'signed_out'|"signed_out"|case\s+401\s*:/;
    for (const s of refusalSurfaces) {
      expect(HANDLES_SIGNED_OUT.test(s.code), `${s.rel} answers a signed-out caller in code`).toBe(true);
    }
  });
});

describe('the console landing page is still mock, and that is pinned rather than assumed', () => {
  /*
   * THE HONEST STATE OF `/console`, recorded because the first version of this file asserted the opposite.
   * It has no authorization check on the page or its layout and renders to a signed-out visitor. Nothing
   * real leaks — every figure on it comes from `mock-data` and the screen says so — but "we refuse instead
   * of redirecting" is not true of it, and a claim is only worth what enforces it.
   *
   * So this pins the premise that makes the absence of a gate acceptable. The day that page reads real data,
   * this fails and someone has to decide deliberately: gate it, or refuse on it.
   */
  const landing = SOURCES.find((f) => f.endsWith(join('app', 'console', 'page.tsx')));

  it('the landing page is found', () => {
    expect(landing, 'apps/web/src/app/console/page.tsx exists').toBeDefined();
  });

  it('renders only mock data — it has no server read to authorize', () => {
    const code = stripComments(readFileSync(landing as string, 'utf8'));
    expect(code).toContain('MOCK_');
    // A real read would arrive as one of these. Any of them appearing means the page now shows real data to
    // whoever asks, and the missing authorization stops being acceptable.
    for (const forbidden of ['ForRequest(', '@acbp/core', 'fetch(', "from '@/server"]) {
      expect(code, `the console landing page must not read real data (${forbidden})`).not.toContain(forbidden);
    }
  });
});
