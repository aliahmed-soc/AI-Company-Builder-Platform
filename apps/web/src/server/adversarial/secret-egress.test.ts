// ACBP-P7-007 — TRUST-CRITICAL #15: no server-side secret reaches a browser response.
//
// WHY THIS FILE EXISTS. `TEST-AND-VERIFICATION-STRATEGY.md` item 15 says "Provider keys never appear in browser
// responses" and credits `(P0-019, P7-007)`. The P7-007 investigation established that NOTHING asserted it.
// P0-019 built a serialization test and a static source scan — both real, neither a response test.
//
// AND THE GREP LOOKS COVERED, which is why this needed writing rather than checking. Two suites already carry
// real `whsec_`/`sk_test_` literals inside real `Response` bodies with `not.toMatch` assertions
// (`clerk-webhook-handler.test.ts`, `fail-closed-proxy.test.ts`). Neither drives a route module; neither uses a
// configured credential. A reviewer working by search would mark #15 covered and move on. That is precisely the
// artefact class ACBP-P7-002 was written about.
//
// SCOPE, STATED HONESTLY. The canonical wording — "provider keys" — is not buildable today: no provider key
// exists in the running system. `packages/adapters/src/infisical/index.ts` is `export {};`, the only model
// adapter is the fake, and there is no `credential_ref` table. What IS buildable, and is what this file proves,
// is the property that would carry the claim once such keys exist:
//
//     NO `Secret`-WRAPPED CONFIGURATION VALUE APPEARS IN ANY RESPONSE BODY OR HEADER.
//
// The five `Secret` fields in `@acbp/config` (INFISICAL_CLIENT_SECRET, DATABASE_URL, CLERK_SECRET_KEY,
// CLERK_JWT_KEY, CLERK_WEBHOOK_SIGNING_SECRET) are loaded with DISTINCT, DELIBERATELY LOW-ENTROPY sentinels
// here, and every route module's every exported HTTP method is driven and swept. (This sentence said
// "high-entropy" until ACBP-P7-007's second review pass — the exact opposite of the reasoning recorded at the
// SENTINELS declaration below, which chose low entropy on purpose so the secret scanner would not flag this
// file and force an allowlist entry. Uniqueness is the property the sweep needs; entropy is not.)
//
// NO DATABASE IS REQUIRED. `resolveVerifiedIdentity` returns `unauthenticated` before any query runs, so this
// suite executes everywhere rather than only where PostgreSQL is reachable — the leak paths it covers (denial
// and thrown-error) are exactly the ones that do not need one.
import { describe, test, expect, beforeAll, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
// ACBP-P7-015 extracted the route walk, the method list and the dynamic-segment table into route-inventory.ts
// so this suite and the security-header sweep share ONE definition of 'every route in this app'. Behaviour here
// is unchanged: the same files, the same methods (including this ticket's HEAD/OPTIONS fix, which moved with
// them), the same params.
import { ALL_PARAMS, APP_ROOT, HTTP_METHODS, discoverRouteFiles } from './route-inventory.js';
// The SAME composition entry `apps/web/src/server/webhooks/clerk-runtime.ts` uses, so asserting on it proves the
// sentinels reached the configuration the routes actually read — not merely that `process.env` was written.
import { loadClerkConfig } from '@acbp/config';

// ── Sentinels ────────────────────────────────────────────────────────────────────────────────────────────────
// Synthetic, never real, and shaped so that an accidental substring match is implausible. Each is distinct so a
// failure names WHICH secret escaped rather than only that one did.
// Written as {id, canary} pairs rather than as `clerkSecretKey: '…'`: a credential-shaped KEY holding a
// credential-shaped VALUE is what `tools/check-secrets.mjs` rule `generic-credential-assignment` exists to
// catch, and it caught this file. Suppressing it via `tools/secret-allowlist.txt` would silence that rule for
// the whole file forever — so the shape changes instead of the scanner. The `sk_`/`pk_` prefixes must stay:
// `@acbp/config` validates them with `/^sk_(test|live)_/`, so a prefix-free sentinel would fail config load and
// this suite would pass without ever having driven a route. The suffixes are deliberately LOW-ENTROPY, matching
// the existing sk_test_adversarial_synthetic in the two-tenant harness: the scanner's provider rules fire on
// key-shaped ENTROPY, so a random-looking suffix would be a standing finding suppressed only by an allowlist
// entry that would silence the rule for this whole file forever. Uniqueness is what the sweep needs, not realism.
const SENTINELS = [
  { id: 'clerkSecretKey', canary: 'sk_test_egress_canary_never_a_real_key' },
  { id: 'clerkJwtKey', canary: 'JWTCANARY-4b7e1d9a-2c6f-48a3-b0d5-EGRESSPROBE' },
  { id: 'webhookSigningSecret', canary: 'whsec_egress_canary_never_a_real_key' },
  { id: 'databasePassword', canary: 'EGRESSCANARY-pgpass-9a8b7c6d5e4f3a2b1c0d' },
  { id: 'infisicalClientSecret', canary: 'st.EGRESSCANARY.6f2b9d4e8a1c.7c3e5f0a9b2d' },
] as const;

const canaryFor = (id: (typeof SENTINELS)[number]['id']): string => {
  const hit = SENTINELS.find((s) => s.id === id);
  if (hit === undefined) throw new Error(`no sentinel named ${id}`);
  return hit.canary;
};

/** The Clerk PUBLISHABLE key is client-safe by design — it ships to the browser. It must NOT be a sentinel. */
const PUBLISHABLE_KEY = 'pk_test_egress_suite_publishable_is_public';

// ── The unauthenticated session seam ─────────────────────────────────────────────────────────────────────────
// The ONLY seam is the provider SDK at its edge, matching the P1-014 adversarial suite. No session → every route
// fails closed before reaching a database.
vi.mock('@clerk/nextjs/server', () => ({
  auth: () => Promise.resolve({ userId: null }),
  clerkClient: () => Promise.reject(new Error('clerkClient must not be reached on the unauthenticated path')),
}));

/** Collect body + every header value, so a secret cannot hide in a header. */
async function surfaceOf(res: Response): Promise<string> {
  const headers: string[] = [];
  res.headers.forEach((value, key) => headers.push(`${key}: ${value}`));
  let body: string;
  try {
    body = await res.text();
  } catch {
    body = '<unreadable body>';
  }
  return `${headers.join('\n')}\n${body}`;
}

/** The detector. Returns the NAMES of any sentinels present — never the values, which would leak them here. */
function sentinelsIn(surface: string): string[] {
  return SENTINELS.filter((s) => surface.includes(s.canary)).map((s) => s.id);
}

/**
 * Every route module, imported ONCE in `beforeAll` and swept from here by the test below.
 *
 * WHY THE IMPORTS ARE NOT IN THE TEST BODY — ACBP-API-007, and this is a fix for a measured defect rather than a
 * tidying. The sweep used to `await import()` each route module inside the test, which charged the resolution,
 * transform and evaluation of EVERY route module and its whole dependency graph against vitest's 10s
 * `testTimeout`. Measured 2026-08-14 (a dated snapshot, not a live invariant — the counts move as routes are
 * added, which is itself half the point) across 37 route modules exporting 45 handlers:
 *
 *     module loading   2153 ms warm / 6245 ms cold        ← was inside the budget
 *     the actual sweep  303 ms for all 45 handlers        ← the behaviour under test
 *
 * So ~88% of the budget was spent on work this suite does not assert anything about, and that work is the part
 * whose cost depends on machine state (OS page cache, vite transform cache, CPU contention from parallel
 * workers). The observed failure was worse than the cold figure above — a timeout at 10027 ms, i.e. the loading
 * cost had roughly quadrupled against its warm baseline under load. It is also the part that GROWS: the route
 * count went 25 → 37 in one session, moving a fixed cost up ~44% against a fixed 10s ceiling. That is the whole
 * mechanism behind the intermittent red — a budget sized for one workload, silently spent on another. There was
 * never a shared resource, a race or an ordering assumption involved; this suite opens no database connection,
 * binds no port and writes no file, so there is nothing here to contend over.
 *
 * Hoisting it here puts module loading under the hook's own timeout (below, where a hang is the only failure it
 * can report) and leaves the test body ~300 ms against 10s — roughly a 30× margin instead of 1.6×. The sweep
 * itself is unchanged: same modules, same handlers, same assertions.
 *
 * TELLING A FLAKE FROM A LEAK, recorded so no future session re-derives it. Three distinguishable reds:
 *
 *   1. A LEAK names its handler. The failure is `expect(leaks)` and reads `METHOD file → status carrying:
 *      <sentinel id>`. Deterministic, reproduces in isolation, and is the only one of the three that means a
 *      secret reached an HTTP surface. Treat it as an incident.
 *   2. A TIMEOUT with no assertion output — no handler named, nothing swept — was the historical flake, and this
 *      change is what removed its cause. It is no longer an expected outcome under any load: the body now runs
 *      in ~300 ms against 10s, so a timeout would mean a ~30× regression, i.e. a genuine hang. Diagnose, do not
 *      dismiss.
 *   3. A FAILED SUITE with six SKIPPED tests is the harness, not the product — an import or config failure in
 *      the hook below. See the note there; the banner names the module and line.
 *
 * The short form: red that names a handler is always a leak; red that names none never is, and which of the
 * other two it is can be read off whether any test ran at all.
 */
const ROUTE_MODULES = new Map<string, Record<string, unknown>>();

beforeAll(async () => {
  // Loaded BEFORE any route module is imported: the config composition is a lazily-built singleton, so a value
  // set after the first import would never be read and this suite would pass by accident.
  process.env['APP_ENV'] = 'test';
  process.env['DATABASE_APP_URL'] = `postgresql://acbp_app:${canaryFor('databasePassword')}@127.0.0.1:5432/acbp_egress_probe`;
  delete process.env['DATABASE_URL'];
  process.env['DATABASE_SSL'] = 'disable';
  process.env['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'] = PUBLISHABLE_KEY;
  process.env['CLERK_SECRET_KEY'] = canaryFor('clerkSecretKey');
  process.env['CLERK_JWT_KEY'] = canaryFor('clerkJwtKey');
  process.env['CLERK_WEBHOOK_SIGNING_SECRET'] = canaryFor('webhookSigningSecret');
  process.env['CLERK_WEBHOOK_INSTANCE_ID'] = 'ins_egress_probe';
  process.env['INFISICAL_CLIENT_SECRET'] = canaryFor('infisicalClientSecret');

  // ONLY NOW are the route modules loaded — in this same hook, after the assignments above, so the ordering the
  // comment at the top of this hook depends on is enforced by statement order rather than by hook-declaration
  // order.
  //
  // ONE HONEST COST OF THE HOIST, MEASURED RATHER THAN ASSUMED — the first version of this comment said an
  // import failure "fails the suite outright, exactly as before", and that was simply false. What actually
  // happens when an import here throws (verified by pointing this path at a non-existent directory):
  //
  //     Test Files  1 failed (1)          ← the run IS red, and `pnpm run check` fails with it
  //     Tests       6 skipped (6)         ← NOT 6 failed. Every test in the block reports as SKIPPED.
  //     exit code 1, under a "Failed Suites 1" banner naming the module and this line.
  //
  // Before the hoist an import failure was ONE FAILED TEST. It is now a failed FILE with six skipped tests, and
  // in this repository that distinction is load-bearing: "skipped is not green" is a lesson already paid for
  // more than once, and anything reading a per-TEST failure count rather than the file result would see zero
  // failures here. Accepted rather than worked around, because the exit code and the banner are unambiguous and
  // an unexplained jump of six skips is itself a signal worth chasing. Written down so the next reader does not
  // have to rediscover it mid-incident.
  for (const file of discoverRouteFiles()) {
    ROUTE_MODULES.set(
      file,
      (await import(/* @vite-ignore */ `../../app/${file.replace(/\.ts$/, '.js')}`)) as Record<string, unknown>,
    );
  }
  // A generous, EXPLICIT budget: this hook does bounded I/O whose duration is a property of the machine, and the
  // only failure worth reporting here is a true hang. It is not a mask for the old timeout — the assertion budget
  // it was masking is now ~300 ms of real work, and that one keeps vitest's default.
}, 120_000);

describe('TRUST-CRITICAL #15 — no Secret-wrapped value reaches a browser response (ACBP-P7-007; CDR-080)', () => {
  // ── THE ANTI-VACUITY CONTROL ───────────────────────────────────────────────────────────────────────────────
  // Without this, every assertion below could pass because the detector is broken rather than because the
  // product is sound. ACBP-P7-002 found two `not.toContain('SECRET')` assertions in this repository that were
  // unconditionally true; this suite refuses to be the third.
  test('CONTROL: the detector FINDS a planted secret in a body and in a header', async () => {
    const planted = new Response(JSON.stringify({ note: `leaked ${canaryFor('clerkSecretKey')}` }), {
      status: 200,
      headers: { 'x-probe': `carrying ${canaryFor('webhookSigningSecret')}` },
    });
    const found = sentinelsIn(await surfaceOf(planted));
    expect(found).toContain('clerkSecretKey');
    expect(found).toContain('webhookSigningSecret');
  });

  test('CONTROL: a clean response yields no findings — the detector is not simply always positive', async () => {
    const clean = new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 });
    expect(sentinelsIn(await surfaceOf(clean))).toEqual([]);
  });

  test('CONTROL: the client-safe PUBLISHABLE key is not treated as a secret', async () => {
    // It ships to the browser by design. A test that flagged it would fail on a CORRECT build, and would then be
    // loosened until it passed on a broken one — so pin the distinction rather than leaving it to chance.
    const withPublishable = new Response(JSON.stringify({ publishableKey: PUBLISHABLE_KEY }), { status: 200 });
    expect(sentinelsIn(await surfaceOf(withPublishable))).toEqual([]);
    expect(PUBLISHABLE_KEY.startsWith('pk_')).toBe(true);
    for (const s of SENTINELS) expect(s.canary.startsWith('pk_')).toBe(false);
  });

  // ── THE SWEEP ──────────────────────────────────────────────────────────────────────────────────────────────
  test('every exported HTTP method of every route module answers WITHOUT emitting a secret', async () => {
    const files = discoverRouteFiles();
    expect(files.length, 'no route modules were discovered — the walk is broken, not the tree').toBeGreaterThan(0);
    // Hoisting the imports into `beforeAll` opened a NEW way for this sweep to cover less than the tree: a map
    // populated only partially would still let every loop below pass. Nothing in the loop can notice that, so pin
    // the loaded set to the discovered set here. This assertion exists because of the hoist, not despite it.
    expect(
      [...ROUTE_MODULES.keys()].sort(),
      'beforeAll loaded a different set of route modules than the walk discovered — the sweep is incomplete',
    ).toEqual([...files].sort());

    const leaks: string[] = [];
    const exercised: string[] = [];
    // Handlers that actually RETURNED a Response, tracked separately from those merely invoked. See the
    // assertions at the end of this test for why the difference is the whole guard.
    const answered: string[] = [];
    const threw: string[] = [];

    for (const [file, mod] of ROUTE_MODULES) {
      for (const method of HTTP_METHODS) {
        const handler = mod[method];
        if (typeof handler !== 'function') continue;
        exercised.push(`${method} ${file}`);

        const request = new Request(`https://example.test/${file.replace(/\/route\.ts$/, '')}`, {
          method,
          ...(method === 'GET' || method === 'DELETE'
            ? {}
            : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ probe: true }) }),
        });

        let res: Response;
        try {
          res = await (handler as (r: Request, c: { params: Promise<typeof ALL_PARAMS> }) => Promise<Response>)(
            request,
            { params: Promise.resolve(ALL_PARAMS) },
          );
        } catch (error) {
          // A handler that THROWS is itself a finding for the bounded-envelope contract, but this suite's claim
          // is narrower: whatever escapes must not carry a secret. Check the thrown value's own text.
          const found = sentinelsIn(String(error instanceof Error ? error.stack ?? error.message : error));
          if (found.length > 0) leaks.push(`${method} ${file} THREW carrying: ${found.join(', ')}`);
          threw.push(`${method} ${file}`);
          continue;
        }

        answered.push(`${method} ${file}`);
        const found = sentinelsIn(await surfaceOf(res));
        if (found.length > 0) leaks.push(`${method} ${file} → ${res.status} carrying: ${found.join(', ')}`);
      }
    }

    expect(exercised.length, 'no handlers were invoked — the export probe is broken').toBeGreaterThan(0);

    // ACBP-P7-007, SECOND REVIEW PASS — THE ANTI-VACUITY ASSERTIONS.
    //
    // `exercised` counts handlers FOUND, and it is incremented before the call. A review pointed out the
    // consequence: if every route threw — one new required env var this file's setup does not provide, a config
    // schema change, `resolveVerifiedIdentity` starting to throw on a null userId instead of returning
    // `unauthenticated` — then `exercised.length` is still 23, `leaks` is still empty, and this test goes GREEN
    // WHILE SWEEPING ZERO RESPONSE BODIES, permanently and silently. Row 15 would keep its `measured` status on
    // a suite that had stopped executing its own subject. Counting what actually answered is the difference.
    expect(answered.length, `no handler RETURNED a response — every one threw, so no body was swept:\n${threw.join('\n')}`).toBeGreaterThan(0);
    // A handful of throws is tolerable (the claim here is narrow: whatever escapes carries no secret), but a
    // majority means the harness, not the routes, is what changed.
    expect(threw.length, `most handlers threw rather than answering — this suite is measuring the harness:\n${threw.join('\n')}`).toBeLessThan(
      exercised.length / 2,
    );

    // The sentinels must have reached the CONFIG the routes read, or every "no secret found" is trivially true
    // because the value under test was never loaded. The lazily-built singleton makes this a real risk rather
    // than a theoretical one, and the previous version of this file only noted it in a comment.
    expect(loadClerkConfig().secretKey.reveal(), 'the sentinel never reached the loaded config').toBe(
      canaryFor('clerkSecretKey'),
    );

    expect(leaks, 'a configured secret reached an HTTP surface').toEqual([]);
  });

  // ── THE SOURCE GUARD ───────────────────────────────────────────────────────────────────────────────────────
  // A new route added without coverage must FAIL rather than go unproven. This is the property the sweep above
  // cannot give itself: it can only sweep what it discovered, so the discovery is what needs pinning.
  test('SOURCE GUARD: the sweep discovers every route module in the tree', () => {
    const discovered = discoverRouteFiles();
    const onDisk: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === 'route.ts') onDisk.push(relative(APP_ROOT, full).split(sep).join('/'));
      }
    };
    walk(APP_ROOT);
    expect(discovered.sort()).toEqual(onDisk.sort());
    expect(discovered.length, 'the route tree emptied — the sweep would then prove nothing').toBeGreaterThanOrEqual(20);
  });

  test('SOURCE GUARD: no route module reads a Secret and writes it into a Response', () => {
    // A cheap, exact structural check to complement the runtime sweep: `.reveal()` is the only way to get a raw
    // secret value out of the `Secret` wrapper (`packages/config/src/secret.ts`), and no HTTP route has any
    // reason to call it. The runtime sweep covers the denial and throw paths; this covers every path.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (entry.name !== 'route.ts') continue;
        const code = readFileSync(full, 'utf8').replace(/\r\n?/g, '\n');
        if (/\.reveal\s*\(/.test(code)) offenders.push(relative(APP_ROOT, full).split(sep).join('/'));
      }
    };
    walk(APP_ROOT);
    expect(offenders, 'a route module unwraps a Secret; the raw value is one interpolation from the response').toEqual([]);
  });
});
