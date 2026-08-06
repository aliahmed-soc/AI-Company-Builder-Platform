#!/usr/bin/env node
// ACBP static check — the CSRF origin gate must stay wired, stay FIRST, and stay blanket (CDR-081 §4).
//
// WHY THIS EXISTS. ACBP-P7-013 enforces CSRF protection at ONE place — `apps/web/src/proxy.ts` — because a
// per-route control is a control someone forgets on route 17, and CDR-080 §0.2's third live mutation is
// exactly that shape ("add a fifth autonomous-work entry point and nothing fails"). Blanket enforcement
// buys the property that a route module which does not exist yet is covered the day it is written.
//
// It also concentrates the risk. The gate cannot be forgotten on one route, but it can be switched off for
// ALL SIXTEEN state-changing routes at once, silently, by any of four edits that each look reasonable in
// isolation — and the most dangerous of them is a change to `config.matcher`, which is a Next.js
// configuration line far from anything that looks like security code. Every functional test that drives the
// gate directly would stay green through it.
//
// So the four are checked statically, plus two more that protect the exemption:
//   1. the gate is called at all;
//   2. it is called BEFORE the session middleware (a denial after a session still refuses the request, but
//      "reaches no Clerk round trip" would have quietly become false);
//   3. the deny branch still returns a 403;
//   4. `config.matcher` still covers /api;
//   5. the webhook bypass is present and is the ONLY path bypass — a second exemption must be an edit to
//      THIS FILE, which is a visible decision rather than a line in the proxy nobody reviews as security;
//   6. every state-changing route module lives under src/app/api, so the /api matcher genuinely covers it.
//
// Exit: 0 = clean, 1 = a violation in the tree, 2 = the checker cannot see its target or failed its own
// self-test. A checker that stops matching prints the same line as a clean repository (CDR-080 §8.4), so
// the self-test runs FIRST and a broken detector never even evaluates the tree.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const WEB_SRC = join(ROOT, 'apps', 'web', 'src');
const PROXY = join(WEB_SRC, 'proxy.ts');
const ROUTE_PATH_MODULE = join(WEB_SRC, 'server', 'webhooks', 'route-path.ts');
const APP_DIR = join(WEB_SRC, 'app');
const ROUTE_FILES = /^route\.(ts|tsx|mts|js|mjs|jsx)$/;

/** The exact path bypassed from the gate. A SECOND entry here is the visible decision rule 5 exists for. */
const DECLARED_EXEMPT_PATHS = ['/api/webhooks/clerk'];

/** RFC 9110 unsafe methods — the ones a forged cross-site request can actually cause a side effect with. */
const STATE_CHANGING = ['POST', 'PUT', 'PATCH', 'DELETE'];

// ── DETECTORS ─────────────────────────────────────────────────────────────────────────────────────────────
// Each is a pure function of source text so the self-test below can exercise it on synthetic inputs.

/** Strip comments and string/template literals, so a method name in prose is never a finding. */
function stripCommentsAndStrings(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[^\n]*?\/\/[^\n]*$/gm, (line) => line.slice(0, line.indexOf('//')))
    .replace(/`(?:\\.|[^`\\])*`/g, "''")
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, "''");
}

/**
 * Which state-changing HTTP methods a route module exports.
 *
 * FOUR DECLARATION SHAPES, deliberately. The repository already uses two of them (`export async function
 * POST` in the companies routes, `export function POST` in the webhook), and nothing stops the next route
 * using `export const` or a renamed re-export. A guard that knows one shape is a guard that reports clean —
 * the four-evasion lesson from check-approval-port.mjs, applied before it costs anything.
 */
function stateChangingExports(source) {
  const code = stripCommentsAndStrings(source);
  const found = new Set();
  for (const method of STATE_CHANGING) {
    const patterns = [
      new RegExp(`export\\s+(?:async\\s+)?function\\s*\\*?\\s*${method}\\b`),
      new RegExp(`export\\s+(?:const|let|var)\\s+${method}\\s*[:=]`),
      new RegExp(`export\\s*\\{[^}]*\\bas\\s+${method}\\s*[,}]`),
      new RegExp(`export\\s*\\{[^}]*(?:^|[{,\\s])${method}\\s*[,}]`),
    ];
    if (patterns.some((p) => p.test(code))) found.add(method);
  }
  return [...found];
}

/**
 * The `matcher` array's body, found by SCANNING rather than by a regex, or null when it is absent.
 *
 * A regex cannot do this, and the real file is the proof: the first matcher entry is
 * `'/((?!_next|[^?]*\\.(?:html?|…)).*)'`, whose `[^?]` puts a `]` INSIDE a string literal. The obvious
 * `\[([\s\S]*?)\]` stopped there, returned a truncated body with no complete literal in it, and the check
 * reported "matcher no longer covers /api" against a proxy whose matcher was perfectly correct. Found on
 * this checker's first run against the real tree, which is the only run that could have found it — every
 * synthetic fixture had a simpler matcher. Bracket depth is tracked with string state so it cannot recur.
 */
function matcherArrayBody(source) {
  const opener = source.match(/matcher\s*:\s*\[/);
  if (opener === null || opener.index === undefined) return null;
  const start = opener.index + opener[0].length;
  let depth = 1;
  let quote = null;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote !== null) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return source.slice(start, i);
  }
  return null;
}

/** The `matcher` array's literal entries, or null when the block cannot be located at all. */
function matcherEntries(proxySource) {
  // Presence is confirmed on STRIPPED code so a `matcher:` living only in a comment is not mistaken for the
  // real declaration; the body is then read from the ORIGINAL text, where the entries still exist.
  if (!/matcher\s*:\s*\[/.test(stripCommentsAndStrings(proxySource))) return null;
  const body = matcherArrayBody(proxySource);
  if (body === null) return null;
  return [...body.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
}

/** Does the matcher still run the proxy for /api? Without this, blanket enforcement covers nothing. */
function matcherCoversApi(entries) {
  return entries.some((e) => /\(\s*api\s*\|/.test(e) || /^\/api\b/.test(e));
}

/** Where the gate call and the session call sit, so their ORDER can be asserted rather than assumed. */
function gateWiring(proxySource) {
  const code = stripCommentsAndStrings(proxySource);
  const gateAt = code.indexOf('decideSameOrigin(');
  const sessionAt = code.search(/sessionProxy\s*\(/);
  // `403` is a numeric literal and survives stripping, so it is the load-bearing half. `forbidden` is a
  // STRING literal, which the stripper erases, so it is matched on the original source — which means a
  // `forbidden` sitting only in a comment would satisfy it. Stated rather than implied: this pair
  // over-matches slightly (a false alarm someone must think about) instead of under-matching, which is the
  // direction check-approval-port.mjs settled on after four evasions were measured against it. The actual
  // proof that removing the deny return goes red is mutation M6, not this line.
  const denies = /403/.test(code) && /forbidden/.test(proxySource);
  return { gateAt, sessionAt, denies };
}

/** Every `return undefined` early exit in the proxy, with the text of its line. */
function pathBypasses(proxySource) {
  const out = [];
  const lines = stripCommentsAndStrings(proxySource).split('\n');
  lines.forEach((line, i) => {
    if (/\breturn\s+undefined\s*;?/.test(line)) out.push({ line: i + 1, text: line.trim() });
  });
  return out;
}

/** Every route module under src/app, as { rel, methods }. `rel` is POSIX-style and app-relative. */
function routeModules(appDir) {
  const out = [];
  if (!existsSync(appDir)) return out;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (ROUTE_FILES.test(name)) {
        out.push({
          rel: relative(appDir, full).split(sep).join('/'),
          methods: stateChangingExports(readFileSync(full, 'utf8')),
        });
      }
    }
  };
  walk(appDir);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

// ── NEGATIVE SELF-TEST ────────────────────────────────────────────────────────────────────────────────────
// Runs BEFORE the tree is read. Every detector must still fire on a synthetic input, or this exits 2 rather
// than letting a silently-blind checker report a clean repository.
{
  const shapes = [
    'export async function POST() {}',
    'export function POST() {}',
    'export const POST = async () => {};',
    'const h = () => {}; export { h as POST };',
    'function POST() {} export { POST };',
  ];
  const detectorOk =
    shapes.every((s) => stateChangingExports(s).includes('POST')) &&
    // …while prose and string literals naming a method are NOT findings…
    stateChangingExports(`// POST handled elsewhere\nconst n = 'export function POST() {}';\nexport function GET() {}`).length === 0 &&
    // …and a safe-method-only module reads as empty rather than as covered-by-accident.
    stateChangingExports('export async function GET() {}').length === 0 &&
    // …and each unsafe method is recognised on its own, not just POST.
    STATE_CHANGING.every((m) => stateChangingExports(`export async function ${m}() {}`).includes(m));

  // The probe that matters is the third: a `]` INSIDE a string literal, which is the shape the real
  // proxy's first entry has and the shape that made this checker's first run report a false failure.
  const realShapedMatcher = `export const config = {
  matcher: [
    '/((?!_next|[^?]*\\\\.(?:html?|css|svg)).*)',
    '/(api|trpc)(.*)',
    '/__clerk/(.*)',
  ],
};`;
  const matcherOk =
    matcherCoversApi(['/(api|trpc)(.*)']) === true &&
    matcherCoversApi(['/api/:path*']) === true &&
    matcherCoversApi(['/((?!_next).*)']) === false &&
    matcherEntries(`export const config = { matcher: ['/(api|trpc)(.*)'] };`)?.length === 1 &&
    matcherEntries(realShapedMatcher)?.length === 3 &&
    matcherCoversApi(matcherEntries(realShapedMatcher) ?? []) === true &&
    matcherEntries('export default proxy;') === null &&
    // A `matcher:` that exists only in prose is not the declaration.
    matcherEntries('// matcher: [ ] was removed\nexport default proxy;') === null;

  const before = `const p = (r) => { const verdict = decideSameOrigin(r, o); return sessionProxy(r); };`;
  const after = `const p = (r) => { const x = sessionProxy(r); return decideSameOrigin(r, o); };`;
  const orderOk =
    gateWiring(before).gateAt < gateWiring(before).sessionAt &&
    gateWiring(after).gateAt > gateWiring(after).sessionAt &&
    gateWiring('const p = (r) => sessionProxy(r);').gateAt === -1;

  const bypassOk =
    pathBypasses('if (isClerkWebhookPath(p)) return undefined;').length === 1 &&
    pathBypasses('if (a) return undefined;\nif (b) return undefined;').length === 2 &&
    pathBypasses('return sessionProxy(r);').length === 0 &&
    // A commented-out bypass is not a bypass — otherwise the stripper's failure would read as a finding.
    pathBypasses('// if (x) return undefined;').length === 0;

  if (!(detectorOk && matcherOk && orderOk && bypassOk)) {
    console.error('✖ csrf-origin-gate check FAILED ITS OWN SELF-TEST — a detector no longer recognises a known shape.');
    console.error(`  methods=${detectorOk} matcher=${matcherOk} order=${orderOk} bypass=${bypassOk}. A clean result would be meaningless.`);
    process.exit(2);
  }
}

// ── CAN THIS CHECK SEE ITS TARGET? ────────────────────────────────────────────────────────────────────────
if (!existsSync(PROXY)) {
  console.error('\n✖ csrf-origin-gate check CANNOT SEE ITS TARGET: apps/web/src/proxy.ts does not exist.');
  console.error('  That file is the CSRF enforcement point (CDR-081 §2). If the request-interception boundary moved,');
  console.error('  move this check with it — do not delete it.\n');
  process.exit(2);
}
const proxySource = readFileSync(PROXY, 'utf8');

const entries = matcherEntries(proxySource);
if (entries === null) {
  console.error('\n✖ csrf-origin-gate check CANNOT SEE ITS TARGET: no `config.matcher` array in apps/web/src/proxy.ts.');
  console.error('  Blanket enforcement is only blanket while the matcher runs the proxy for /api, and this check can no');
  console.error('  longer tell whether it does.\n');
  process.exit(2);
}

// ── VIOLATIONS ────────────────────────────────────────────────────────────────────────────────────────────
const failures = [];
const { gateAt, sessionAt, denies } = gateWiring(proxySource);

if (gateAt === -1) {
  failures.push(
    'apps/web/src/proxy.ts no longer calls `decideSameOrigin(...)`. The CSRF gate is OFF for every state-changing route.',
  );
} else if (sessionAt !== -1 && gateAt > sessionAt) {
  failures.push(
    'the gate is called AFTER `sessionProxy(...)`. It must run BEFORE the session is established, so a forged request ' +
      'costs no Clerk round trip and reaches no handler (CDR-081 §2, ordering step 2).',
  );
}
if (gateAt !== -1 && !denies) {
  failures.push('apps/web/src/proxy.ts no longer returns a 403 `forbidden` on a deny verdict — the gate decides and then does nothing.');
}
if (!matcherCoversApi(entries)) {
  failures.push(
    `config.matcher no longer covers /api (entries: ${entries.map((e) => JSON.stringify(e)).join(', ')}). The proxy would ` +
      'not run for the API routes at all, so the gate would be dead while every test that calls it directly stayed green.',
  );
}

const bypasses = pathBypasses(proxySource);
const webhookBypasses = bypasses.filter((b) => /isClerkWebhookPath/.test(b.text));
if (webhookBypasses.length === 0) {
  failures.push(
    'the Clerk webhook bypass is gone from apps/web/src/proxy.ts. Clerk sends neither Origin nor Sec-Fetch-Site, so ' +
      'without it every authentic signed webhook is denied by the no-provenance row and identity ingestion breaks.',
  );
}
for (const extra of bypasses.filter((b) => !/isClerkWebhookPath/.test(b.text))) {
  failures.push(
    `apps/web/src/proxy.ts:${extra.line} adds a SECOND path bypass beside the webhook one (\`${extra.text}\`). A new ` +
      'exemption from the CSRF gate must be a deliberate edit to tools/check-csrf-origin-gate.mjs, not a line in the proxy.',
  );
}

if (existsSync(ROUTE_PATH_MODULE)) {
  const declared = readFileSync(ROUTE_PATH_MODULE, 'utf8').match(/CLERK_WEBHOOK_PATH\s*=\s*(['"`])([^'"`]*)\1/);
  if (declared === null) {
    failures.push('apps/web/src/server/webhooks/route-path.ts no longer declares CLERK_WEBHOOK_PATH as a literal.');
  } else if (!DECLARED_EXEMPT_PATHS.includes(declared[2])) {
    failures.push(
      `CLERK_WEBHOOK_PATH is "${declared[2]}", which is not the declared exempt path ${JSON.stringify(DECLARED_EXEMPT_PATHS)}. ` +
        'Widening it widens the hole in the CSRF gate.',
    );
  }
}

const routes = routeModules(APP_DIR);
const stateChanging = routes.filter((r) => r.methods.length > 0);
for (const route of stateChanging) {
  if (!route.rel.startsWith('api/')) {
    failures.push(
      `apps/web/src/app/${route.rel} exports ${route.methods.join('/')} but does NOT live under src/app/api, so the ` +
        '`/(api|trpc)(.*)` matcher entry does not cover it. Move it under api/, or extend the matcher AND this check ' +
        'together — the point is that widening coverage is a visible decision.',
    );
  }
}

if (failures.length > 0) {
  console.error('\n✖ THE CSRF ORIGIN GATE IS NOT WHERE ACBP-P7-013 PUT IT.\n');
  for (const f of failures) console.error(`  - ${f}`);
  console.error('\n  The gate is the only CSRF protection apps/web has (CDR-081 §0.2: no provider control covers this).');
  console.error('  Fix the wiring rather than this check.\n');
  process.exit(1);
}

console.log(
  `✔ csrf-origin-gate check: gate wired before the session, matcher covers /api, ${DECLARED_EXEMPT_PATHS.length} declared ` +
    `exempt path; ${stateChanging.length} state-changing of ${routes.length} route module(s), all under api/. Self-test passed.`,
);
