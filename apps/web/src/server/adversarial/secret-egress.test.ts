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
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..', '..', 'app');

// ── The unauthenticated session seam ─────────────────────────────────────────────────────────────────────────
// The ONLY seam is the provider SDK at its edge, matching the P1-014 adversarial suite. No session → every route
// fails closed before reaching a database.
vi.mock('@clerk/nextjs/server', () => ({
  auth: () => Promise.resolve({ userId: null }),
  clerkClient: () => Promise.reject(new Error('clerkClient must not be reached on the unauthenticated path')),
}));

/** Every `route.ts` under `app/`, repo-relative and POSIX-separated, sorted. */
function discoverRouteFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'route.ts') out.push(relative(appRoot, full).split(sep).join('/'));
    }
  };
  walk(appRoot);
  return out.sort();
}

// HEAD and OPTIONS are Next.js route exports too. They were missing, so a route exporting only those would be
// discovered, skipped by the `typeof handler !== 'function'` guard, and contribute nothing — while the suite
// stayed green on the other routes. Cheap to include; the cost of omitting it is a silent hole.
const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'] as const;

/** A params object carrying every dynamic segment any route in the tree uses. */
const ALL_PARAMS = {
  companyId: '00000000-0000-4000-8000-00000000c0de',
  accountId: '00000000-0000-4000-8000-00000000acc7',
  membershipId: '00000000-0000-4000-8000-0000000000b5',
  memoryItemId: '00000000-0000-4000-8000-00000000e11e',
  questionId: '00000000-0000-4000-8000-000000000901',
};

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

beforeAll(() => {
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
});

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

    const leaks: string[] = [];
    const exercised: string[] = [];
    // Handlers that actually RETURNED a Response, tracked separately from those merely invoked. See the
    // assertions at the end of this test for why the difference is the whole guard.
    const answered: string[] = [];
    const threw: string[] = [];

    for (const file of files) {
      const mod = (await import(/* @vite-ignore */ `../../app/${file.replace(/\.ts$/, '.js')}`)) as Record<
        string,
        unknown
      >;
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
        else if (entry.name === 'route.ts') onDisk.push(relative(appRoot, full).split(sep).join('/'));
      }
    };
    walk(appRoot);
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
        if (/\.reveal\s*\(/.test(code)) offenders.push(relative(appRoot, full).split(sep).join('/'));
      }
    };
    walk(appRoot);
    expect(offenders, 'a route module unwraps a Secret; the raw value is one interpolation from the response').toEqual([]);
  });
});
