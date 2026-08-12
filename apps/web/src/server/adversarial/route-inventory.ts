// ACBP-P7-015 — the single definition of "every route in this app", shared by the adversarial sweeps.
//
// EXTRACTED, NOT INVENTED. ACBP-P7-007's `secret-egress.test.ts` built this walk to drive every exported HTTP
// method of every route module with no database. ACBP-P7-015's `security-headers.test.ts` needs the same
// inventory to prove every route answers with the security headers. Two copies of a security sweep's DISCOVERY
// is how one copy quietly stops finding things — so there is one, and both suites import it.
//
// TEST SUPPORT ONLY. Nothing in the request path imports this file; it reads the source tree from disk.
import { readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `apps/web/src/app` — the App Router tree these sweeps walk. */
export const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app');

/**
 * The HTTP methods a Next.js Route Handler may export.
 *
 * HEAD and OPTIONS are in the list because ACBP-P7-007 put them there: without them a route exporting only
 * those would be discovered, skipped by the caller's `typeof handler !== 'function'` guard, and contribute
 * nothing — while the suite stayed green on the other routes. That fix arrived on the base branch after this
 * module was extracted, and it moved in here with the list rather than being dropped in the rebase.
 */
export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'] as const;

/** A params object carrying every dynamic segment any route in the tree uses. */
export const ALL_PARAMS = {
  companyId: '00000000-0000-4000-8000-00000000c0de',
  accountId: '00000000-0000-4000-8000-00000000acc7',
  membershipId: '00000000-0000-4000-8000-0000000000b5',
  memoryItemId: '00000000-0000-4000-8000-00000000e11e',
  questionId: '00000000-0000-4000-8000-000000000901',
  // CDR-088. Added because the sweep THREW on the new [taskId] segment rather than skipping the route: a route
  // it cannot build a URL for is a route it cannot sweep, and silently passing over it would have left the task
  // detail endpoint outside the security-headers and secret-egress guarantees while the suite stayed green.
  taskId: '00000000-0000-4000-8000-000000007a5c',
  artifactId: '00000000-0000-4000-8000-000000000a27',
  // Hex only — 'ru' would not survive a uuid cast, and a sweep value that cannot be parsed tests the error path
  // rather than the route.
  runId: '00000000-0000-4000-8000-00000000c0d3',
};

// EVERY EXTENSION NEXT ACTUALLY ROUTES, not just the ones this app happens to use today. Matching the literal
// string 'route.ts' would make `foo/route.js` or a page renamed to `.jsx` INVISIBLE to discovery — and a sweep
// that cannot see a surface reports it as covered by saying nothing about it.
const ROUTE_FILE = /^route\.(?:[cm]?[jt]s|[jt]sx)$/;
const PAGE_FILE = /^page\.(?:[cm]?[jt]s|[jt]sx|mdx)$/;

function discoverFiles(match: RegExp): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // A `_`-prefixed folder is a Next PRIVATE folder: nothing inside it is routable, so it must not enter the
      // inventory at all. Excluded here rather than thrown on, because opting a folder out of routing is a
      // legitimate thing to do and is not an unhandled shape.
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('_')) walk(join(dir, entry.name));
        continue;
      }
      if (match.test(entry.name)) out.push(relative(APP_ROOT, join(dir, entry.name)).split(sep).join('/'));
    }
  };
  walk(APP_ROOT);
  return out.sort();
}

/** Every route-handler file under `app/`, repo-relative to APP_ROOT, POSIX-separated, sorted. */
export function discoverRouteFiles(): string[] {
  return discoverFiles(ROUTE_FILE);
}

/**
 * Every page file under `app/` — the HTML surfaces. Route handlers are not the whole browser-facing app, and a
 * sweep that only walked route handlers would silently exclude the pages where scripts actually execute.
 */
export function discoverPageFiles(): string[] {
  return discoverFiles(PAGE_FILE);
}

/**
 * The request pathname a route file serves, with dynamic segments filled from ALL_PARAMS —
 * `api/companies/[companyId]/pause/route.ts` becomes `/api/companies/0000…c0de/pause`.
 *
 * Real segment values matter: `proxy.ts` decides the webhook bypass by comparing the pathname, so a sweep that
 * left `[companyId]` in the URL would exercise a path shape the product never sees.
 *
 * @throws if a dynamic segment has no entry in ALL_PARAMS — a new `[thing]` segment must be a loud failure
 *         here, not a literal `[thing]` silently swept as if it were a real path.
 */
export function routePathFor(routeFile: string): string {
  return pathFor(routeFile, ROUTE_FILE);
}

/**
 * The request pathname a page file serves. An OPTIONAL catch-all segment (`[[...sign-in]]`) matches zero
 * segments, so `sign-in/[[...sign-in]]/page.tsx` serves `/sign-in`, and `page.tsx` serves `/`.
 */
export function pagePathFor(pageFile: string): string {
  return pathFor(pageFile, PAGE_FILE);
}

/**
 * EVERY App Router segment shape is handled or THROWN ON — never guessed.
 *
 * The earlier version of this function handled dynamic segments and passed everything else through literally,
 * which turned a route group into the path `/(marketing)/about`. Because the boundary adds headers to any input,
 * a sweep of that fictional path would have gone green while the real `/about` was never driven — a covered-set
 * report about paths the product does not serve. Silence was the defect, so the unhandled shapes now shout.
 */
function pathFor(file: string, suffix: RegExp): string {
  const filled = file
    .split('/')
    .filter((segment) => !suffix.test(segment))
    .filter(Boolean)
    .filter((segment) => {
      // An INTERCEPTING route — (.)x, (..)x, (...)x — serves a path derived from a DIFFERENT level of the tree.
      // Working it out needs rules this helper does not implement, so it must fail loudly rather than guess.
      if (/^\(\.{1,3}\)/.test(segment)) {
        throw new Error(`intercepting-route segment ${segment} in ${file} is not handled; teach pathFor`);
      }
      // A route GROUP `(marketing)` and a PARALLEL-ROUTE slot `@modal` organise the tree and never appear in a
      // URL. An OPTIONAL catch-all `[[...x]]` matches zero segments, so it contributes nothing to the shortest
      // path it serves.
      return !/^\(.*\)$/.test(segment) && !segment.startsWith('@') && !/^\[\[\.\.\..+\]\]$/.test(segment);
    })
    .map((segment) => {
      const dynamic = /^\[(?:\.\.\.)?(.+?)\]$/.exec(segment);
      if (dynamic === null) return segment;
      const name = dynamic[1] as keyof typeof ALL_PARAMS;
      const value = ALL_PARAMS[name];
      // A new [thing] segment must be a LOUD failure here, not a literal "[thing]" quietly swept as if it were a
      // real path — a sweep of paths the product never serves proves nothing about the paths it does.
      if (value === undefined) {
        throw new Error(`dynamic segment [${String(name)}] in ${file} has no ALL_PARAMS value; add one`);
      }
      return value;
    });
  return `/${filled.join('/')}`;
}
