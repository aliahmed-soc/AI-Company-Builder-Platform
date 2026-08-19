#!/usr/bin/env node
// ACBP-API-008 slice 3b — the metered-route coverage check (CDR-092 §6, §7.5, §11).
//
// WHY THIS EXISTS, AND WHY IT IS NOT `check-rate-limit-coverage.mjs` AGAIN.
//
// Four routes in this application cause a PAID provider call. Each one is safe only because it passes through
// `resolveMeteredContext` — the per-company ceiling — before the use case is invoked, and each one is proven to
// refuse when that ceiling refuses by a behavioural test that asserts the metered method is never reached.
//
// Those tests are per-route, which means they cannot say anything at all about a FIFTH generate route added
// next year by someone who did not read them. This check is the part that can: it enumerates from the
// filesystem, so a new route joins the checked set the moment the file exists.
//
// ── WHY FILE-LEVEL REACHABILITY WOULD BE A CHECK THAT COULD NOT FAIL ─────────────────────────────────────────
//
// `check-rate-limit-coverage.mjs` walks imports and asks "does this handler reach `verified-identity.ts`". That
// question works there because the enforcement point is a DIFFERENT MODULE from the routes. Here it is not: the
// company ceiling and the metered call live in the same file, `companies-request.ts`, which EVERY companies
// route already imports. A transitive-import walk would therefore return true for a route that deliberately
// bypassed the ceiling — a green light that could not have come out any other way, which is the exact defect
// the standing rule at the top of AUTONOMOUS-RUN-LOG.md was written for.
//
// So the question is asked one level finer: which request-layer function does this route call, and does THAT
// function go through the metered path. Structural, not semantic — it proves the metered entry point is used,
// not that its result is obeyed. Obedience is proven behaviourally (CDR-092 §11), because a source check cannot
// distinguish a branch that refuses from a branch that logs and continues.
//
// EXIT CODES: 0 pass · 1 a real failure · 2 the check could not see what it is meant to check (a vanished
// directory is NOT agreement — the same rule as `check-cursor-rules-sync.mjs`).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

// The default root only. Both paths this check reads are derived INSIDE `check(root)` from its argument, so the
// regression suite can point the whole check at a throwaway tree — a checker that could only ever read the real
// repository is one whose failure modes can never be exercised.
const ROOT = process.argv[2] ? resolve(process.argv[2]) : process.cwd();

/**
 * A route directory named one of these is a METERED route and must be covered.
 *
 * Naming, not an allowlist of paths: an allowlist is a list somebody has to remember to extend, and the whole
 * point of this check is to catch the route added by someone who did not know it existed. The cost is that a
 * metered route named something else escapes — which is why `EXPECTED_MINIMUM` below is a floor on the count
 * and the four known routes are named explicitly in `EXPECTED_ROUTES`.
 */
const METERED_DIR_NAMES = new Set(['generate', 'recommend', 'evaluate', 'assumption']);

/** The six that exist today. A missing one fails: renaming a money route must never quietly shrink this set. */
const EXPECTED_ROUTES = [
  'apps/web/src/app/api/companies/[companyId]/strategy/generate/route.ts',
  'apps/web/src/app/api/companies/[companyId]/strategy/recommend/route.ts',
  'apps/web/src/app/api/companies/[companyId]/roadmap/generate/route.ts',
  'apps/web/src/app/api/companies/[companyId]/tasks/generate/route.ts',
  // ACBP-API-013 — the interview pair. Both spend money per call, and neither sits in a `generate` directory,
  // which is precisely the escape the `METERED_RUNTIME_METHODS` rule below was written to close.
  'apps/web/src/app/api/companies/[companyId]/interview/questions/[questionId]/evaluate/route.ts',
  'apps/web/src/app/api/companies/[companyId]/interview/questions/[questionId]/assumption/route.ts',
];

/**
 * The floor. CDR-092 §7.5: "a checker that discovers zero generate routes and reports success is the exact
 * artefact the standing rule warns about". This is the assertion that makes an empty walk loud.
 */
const EXPECTED_MINIMUM = 6;

/**
 * The helpers a metered request function may go through, each paired with the authorization call it must make
 * BEFORE debiting the company bucket.
 *
 * ⚠️ THERE IS MORE THAN ONE BECAUSE THE POSTURES DIFFER, NOT BECAUSE THE RULE DOES. `resolveMeteredContext`
 * gates the four generate routes on `authorizeMeteredGenerate`, which is closed to four OWNER-ONLY actions.
 * Answering an interview question is not owner-only — `evaluateAnswer` inherits `interview:read` and
 * `memory:write`, both owner+viewer — so a member-level sibling exists. Widening the owner-only set instead
 * would have been the cheaper edit and the wrong one: it would have silently granted viewers the four generate
 * actions to make two interview routes work. Every helper here owes the SAME ceiling guarantees below.
 */
const METERED_HELPERS = [
  { name: 'resolveMeteredContext', authz: 'authorizeMeteredGenerate' },
  { name: 'resolveMeteredParticipateSession', authz: 'authorizeMeteredParticipate' },
];

/** What every metered helper must itself contain, over and above its own authorization call. */
const HELPER_REQUIREMENTS = [
  { needle: "checkRequestLimit('company'", why: 'the per-company ceiling must actually be consumed' },
  { needle: "limit.kind === 'throttled'", why: 'a throttled ceiling must be recognised' },
  { needle: "limit.kind === 'unavailable'", why: 'an unreadable bucket must fail CLOSED, not fall through' },
];

/** Does this function body reach the paid path through one of the verified ceilings? */
function goesThroughMeteredHelper(body) {
  return METERED_HELPERS.some((h) => body.includes(`${h.name}(`));
}

/** The names only, for messages that have to tell a reader what the acceptable options were. */
const METERED_HELPER_NAMES = METERED_HELPERS.map((h) => h.name).join(' or ');

/** The non-metered resolver. Its presence inside a metered function means the ceiling was skipped. */
const UNMETERED_HELPER = 'resolveActorWithAccount';

/**
 * The runtime methods that SPEND MONEY, checked from the other direction.
 *
 * Everything above keys on a route directory being named `generate` or `recommend`, which an adversarial review
 * of this checker broke in one line: a paid route at `brief/compose` was never examined at all, and the
 * `EXPECTED_MINIMUM` floor did not help — it counts routes matching the convention, so a route outside the
 * convention neither raises nor lowers it. The mitigation named in the comment above was simply unrelated to the
 * gap it claimed to mitigate.
 *
 * This rule does not care what the route is called. Any request-layer function that invokes one of these methods
 * must go through the company ceiling, so the naming convention becomes an optimisation rather than the
 * load-bearing assumption. `steerTaskPlanning` is listed although nothing exposes it yet: it already spends
 * money through the same gateway, and the point is to catch the route that exposes it.
 */
const METERED_RUNTIME_METHODS = [
  'generateStrategyOptions',
  'recommendStrategy',
  'generateRoadmap',
  'generateTasks',
  'steerTaskPlanning',
  // ACBP-API-013. Both reach the model gateway: `evaluateAnswer` classifies an answer (DISC-003/004) and
  // `suggestAssumptionForSkip` composes an `ai_assumption` (DISC-005). Listed here rather than relying on the
  // directory names above, because this is the rule that survives someone renaming the route.
  'evaluateAnswer',
  'suggestAssumptionForSkip',
];

/** Every HTTP method Next.js will route. All of them are examined, not just POST. */
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/**
 * Source with comments blanked out, newlines preserved.
 *
 * WHY: every check below is `includes(needle)` over source text, and comments are source text. The single most
 * likely way this guard dies is not a deletion but a TODO — the ceiling commented out with a note to restore it
 * — and that leaves all three marker strings present in the file. A review demonstrated exactly this: the helper
 * reduced to comments passed. Comments are removed before matching so that inert text cannot vouch for a guard.
 *
 * String and template literals are preserved, because the needles themselves contain quotes
 * (`checkRequestLimit('company'`), and a `//` inside a string must not start a comment.
 */
export function stripComments(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        // Newlines are kept so that line-based reasoning elsewhere is not shifted by a block comment.
        if (source[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === quote) {
          i += 1;
          break;
        }
        // An unterminated single/double quote ends at the newline rather than eating the rest of the file.
        if (quote !== '`' && source[i] === '\n') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** The HTTP methods a route file exports, by either declaration form. */
export function exportedMethods(source) {
  return HTTP_METHODS.filter((m) => new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b`).test(source) || new RegExp(`export\\s+const\\s+${m}\\b`).test(source));
}

/** Every top-level `*ForRequest` function declared in the request module. */
export function requestFunctionNames(source) {
  const names = [];
  const re = /^(?:export\s+)?(?:async\s+)?function\s+(\w+ForRequest)\b/gm;
  let m;
  while ((m = re.exec(source)) !== null) names.push(m[1]);
  return names;
}

export function listRouteFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listRouteFiles(full, out);
    else if (entry === 'route.ts' || entry === 'route.tsx') out.push(full);
  }
  return out;
}

/** Is this route file inside a directory the naming convention marks as metered? */
export function isMeteredRoute(file) {
  return METERED_DIR_NAMES.has(basename(dirname(file)));
}

/**
 * The request-layer functions a route imports from `companies-request`.
 *
 * Deliberately scoped to that module: a route importing a same-named function from anywhere else has not been
 * checked, and would be reported as uncovered rather than assumed fine.
 */
export function requestFunctionsOf(source) {
  const names = [];
  const re = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*companies-request['"]/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (name !== '') names.push(name);
    }
  }
  return names;
}

/**
 * The source text of one exported function, from its signature to the closing brace in column 0.
 *
 * Brace-column matching rather than a parser: this repository is prettier-formatted with a 100% consistent
 * top-level function shape, and a real parser would be a dependency and a second thing to keep working. It
 * returns null when the function is not found, and the caller treats null as a FAILURE — never as "fine".
 */
export function functionBody(source, name) {
  // `export` is OPTIONAL: the metered helper is deliberately module-private, and requiring the keyword would
  // have made this check fail for the one function it most needs to read.
  const start = source.search(new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`, 'm'));
  if (start === -1) return null;
  const rest = source.slice(start);
  /*
   * FINDING THE BODY'S OPENING BRACE NEEDS BOTH SIGNALS, and using either alone is a bug this file has now had.
   *
   * `rest.indexOf('{')` is WRONG: a signature's own type annotation contains braces —
   *     async function resolveMeteredParticipateSession(...): Promise<{ userId: string; ... } | Early> {
   * so the first `{` belongs to the RETURN TYPE, and matching it yields a two-line "body" in which every needle
   * is missing. That produced 26 false failures against the real repository.
   *
   * A column-0 `}` alone is also wrong — that was the original bug, broken by any template literal.
   *
   * So: take the first `{` whose MATCHING brace lands in column 0. Type annotations close inline; a top-level
   * function's body closes at the start of a line, in this prettier-formatted repository. Brace matching skips
   * string and template literals, so a JSON-shaped prompt no longer ends the function early.
   */
  for (let open = rest.indexOf('{'); open !== -1; open = rest.indexOf('{', open + 1)) {
    const end = matchingBrace(rest, open);
    if (end === -1) return null;
    if (end === 0 || rest[end - 1] === '\n') return rest.slice(0, end + 1);
  }
  return null;
}

/**
 * Index of the `}` that closes the `{` at `open`, skipping braces inside string and template literals.
 *
 * ⚠️ THIS REPLACED A ONE-LINE `rest.search(/^\}/m)` THAT AN ADVERSARIAL REVIEW BROKE, and the break was not
 * theoretical. That version ended a function at the first `}` in column 0 — which any template literal supplies
 * the moment it contains a JSON-shaped prompt:
 *
 *     const prompt = `Reply as JSON:
 *     {
 *       "summary": "..."
 *     }`;
 *
 * The extracted body then stopped mid-literal, the paid `runtime.*` call fell OUTSIDE it, and the paid-method
 * rule found nothing to complain about. A tree that should have failed returned `code = 0, failures = 0`. A
 * model-calling request function containing a JSON prompt is not an exotic shape — it is the likeliest shape.
 *
 * `stripComments` runs before this, so comments cannot contain a brace by the time we get here; string and
 * template literals are deliberately PRESERVED (the needles contain quotes), so they must be skipped here.
 * Template substitutions nest, so `${` pushes back into code.
 */
export function matchingBrace(source, open) {
  let depth = 0;
  let i = open;
  while (i < source.length) {
    const c = source[i];
    if (c === "'" || c === '"') {
      const q = endOfQuoted(source, i, c);
      if (q === -1) return -1;
      i = q + 1;
      continue;
    }
    if (c === '`') {
      // `endOfTemplate` returns the index just PAST the closing backtick, substitutions included.
      const t = endOfTemplate(source, i);
      if (t === -1) return -1;
      i = t;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/** Index of the closing quote for the literal opening at `start`, honouring backslash escapes. */
function endOfQuoted(source, start, quote) {
  for (let i = start + 1; i < source.length; i += 1) {
    if (source[i] === '\\') {
      i += 1;
      continue;
    }
    if (source[i] === quote) return i;
    // An unterminated single-quoted string cannot span a newline in valid source; bail rather than run to EOF.
    if (source[i] === '\n') return -1;
  }
  return -1;
}

/**
 * Skip a template literal, INCLUDING its `${ ... }` substitutions, and return the index just past its closing
 * backtick. Substitutions may themselves contain braces, strings and nested templates.
 */
function endOfTemplate(source, start) {
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') return i + 1;
    if (c === '$' && source[i + 1] === '{') {
      // Walk the substitution as code until its brace balances.
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        const s = source[i];
        if (s === '\\') {
          i += 2;
          continue;
        }
        if (s === "'" || s === '"') {
          const q = endOfQuoted(source, i, s);
          if (q === -1) return -1;
          i = q + 1;
          continue;
        }
        if (s === '`') {
          const t = endOfTemplate(source, i);
          if (t === -1) return -1;
          i = t;
          continue;
        }
        if (s === '{') depth += 1;
        else if (s === '}') depth -= 1;
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return -1;
}

/**
 * Every top-level `function` declared in the request module, whatever it is called.
 *
 * SEPARATE FROM `requestFunctionNames` ON PURPOSE. That one keys on the `*ForRequest` convention, which is right
 * for matching a route's imports — a route importing something else has not been checked and is reported as such.
 * It is WRONG for the paid-method rule: an adversarial review showed that a one-word rename of a money-spending
 * function put it outside the convention and therefore outside the sweep entirely, with `code = 0`. The rule that
 * asks "does anything here call a paid method without a ceiling" must look at everything, not at a naming habit.
 */
export function topLevelFunctionNames(source) {
  const names = [];
  const re = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\b/gm;
  let m;
  while ((m = re.exec(source)) !== null) names.push(m[1]);
  return names;
}

/** Self-test: the extractor must actually extract, or every verdict below is vacuous. */
function selfTest() {
  const sample = ['export async function alpha(x) {', "  const ctx = await resolveMeteredContext(a, b, c);", '  return ctx;', '}', '', 'export function beta() {', '  return 1;', '}', ''].join('\n');
  const alpha = functionBody(sample, 'alpha');
  const problems = [];
  if (alpha === null || !alpha.includes(METERED_HELPERS[0].name)) problems.push('functionBody did not extract a body containing its own text');
  if (alpha !== null && alpha.includes('beta')) problems.push('functionBody ran past the closing brace into the next function');
  if (functionBody(sample, 'gamma') !== null) problems.push('functionBody invented a body for a function that does not exist');
  // `goesThroughMeteredHelper` must recognise EVERY helper, not just the first. A version that only ever matched
  // `METERED_HELPERS[0]` would report the two interview routes as uncovered — and, worse, a future third helper
  // silently as well.
  for (const h of METERED_HELPERS) {
    if (!goesThroughMeteredHelper(`  const c = await ${h.name}(a, b);`)) problems.push(`goesThroughMeteredHelper did not recognise ${h.name}`);
  }
  if (goesThroughMeteredHelper('  const c = await resolveActorWithAccount(a, b);')) problems.push('goesThroughMeteredHelper accepted the UNMETERED resolver');
  if (requestFunctionsOf("import { a, type B, c as d } from '@/server/companies/companies-request';").join(',') !== 'a,B,c') {
    problems.push('requestFunctionsOf did not parse a mixed import clause');
  }
  if (isMeteredRoute(join('x', 'strategy', 'generate', 'route.ts')) !== true) problems.push('isMeteredRoute missed a generate directory');
  if (isMeteredRoute(join('x', 'strategy', 'route.ts')) !== false) problems.push('isMeteredRoute claimed a plain route was metered');
  // The comment stripper is now load-bearing for every needle below it: if it stops removing comments, a
  // commented-out ceiling passes, and if it starts removing string contents, every needle vanishes and the check
  // fails everything. Both directions are asserted.
  const commented = stripComments(["// const limit = await runtime.checkRequestLimit('company', id);", "const s = 'http://x//y';", '/* block', "checkRequestLimit('company'", '*/', 'const t = 1;'].join('\n'));
  if (commented.includes('checkRequestLimit')) problems.push('stripComments left commented-out code behind, so inert text can vouch for a guard');
  if (!commented.includes("'http://x//y'")) problems.push('stripComments ate a string containing a double slash');
  if (!commented.includes('const t = 1;')) problems.push('stripComments swallowed live code after a block comment');
  if (exportedMethods('export async function POST(r) {}\nexport const GET = h;').join(',') !== 'GET,POST') problems.push('exportedMethods missed a declaration form');
  if (requestFunctionNames('export async function aForRequest() {}\nfunction bForRequest() {}\nfunction c() {}').join(',') !== 'aForRequest,bForRequest') {
    problems.push('requestFunctionNames did not enumerate the request functions');
  }
  return problems;
}

export function check(root = ROOT) {
  const appDir = join(root, 'apps', 'web', 'src', 'app', 'api');
  const requestModule = join(root, 'apps', 'web', 'src', 'server', 'companies', 'companies-request.ts');
  const rel = (f) => relative(root, f).split('\\').join('/');
  const blind = [];
  if (!existsSync(appDir)) blind.push(`the route directory is not there: ${rel(appDir)}`);
  if (!existsSync(requestModule)) blind.push(`the request module is not there: ${rel(requestModule)}`);
  if (blind.length > 0) return { code: 2, blind, failures: [], covered: [] };

  const failures = [];
  // Comments are stripped BEFORE any matching. See `stripComments`: a commented-out ceiling keeps every needle.
  const requestSource = stripComments(readFileSync(requestModule, 'utf8'));

  // The helper itself, first. Everything below leans on it, so a checker that verified the routes reach a
  // helper that no longer enforces anything would be measuring a pipe with nothing in it.
  for (const helper of METERED_HELPERS) {
    const helperBody = functionBody(requestSource, helper.name);
    if (helperBody === null) {
      // A VANISHED HELPER IS A FAILURE, NOT A SKIP. If this were `continue`, deleting a helper would delete the
      // only thing that checks it, and the routes below would then fail for a reason nobody could read.
      failures.push(`${helper.name} is not a top-level function in ${rel(requestModule)} — the metered routes that use it depend on it.`);
      continue;
    }
    for (const { needle, why } of HELPER_REQUIREMENTS) {
      if (!helperBody.includes(needle)) failures.push(`${helper.name} no longer contains \`${needle}\` — ${why}.`);
    }
    if (!helperBody.includes(helper.authz)) {
      failures.push(`${helper.name} no longer calls ${helper.authz} — the company bucket would be consumed with no authorization in front of it (CDR-092 §15).`);
    }
    // CDR-092 §15: presence is not order. A helper that authorizes after debiting still drains the bucket
    // on a 403. The authorize call must appear BEFORE the company consume.
    const authzAt = helperBody.indexOf(helper.authz);
    const debitAt = helperBody.indexOf("checkRequestLimit('company'");
    if (authzAt !== -1 && debitAt !== -1 && authzAt > debitAt) {
      failures.push(`${helper.name} consults ${helper.authz} AFTER debiting the company bucket — that is the drain CDR-092 §15 closed.`);
    }
  }

  /**
   * THE RULE THAT DOES NOT DEPEND ON A DIRECTORY NAME. Every `*ForRequest` function that invokes a paid runtime
   * method must go through the ceiling — whatever route, if any, sits above it. This is what catches the metered
   * route named something the convention below has never heard of.
   */
  for (const name of topLevelFunctionNames(requestSource)) {
    const body = functionBody(requestSource, name);
    if (body === null) {
      // UNREADABLE IS NOT SAFE. This was a bare `continue`, so a function the extractor could not delimit was
      // silently exempted from the only rule that does not depend on a naming convention — and the extractor
      // could be defeated by a template literal. The file says "unchecked is not the same as safe" elsewhere;
      // it now says it here too.
      failures.push(`${rel(requestModule)}\n    ${name} could not be read as a top-level function, so it has NOT been checked for paid calls — and unchecked is not the same as safe.`);
      continue;
    }
    const paid = METERED_RUNTIME_METHODS.filter((m) => body.includes(`.${m}(`));
    if (paid.length > 0 && !goesThroughMeteredHelper(body)) {
      failures.push(
        `${rel(requestModule)}\n    ${name} calls the paid method(s) ${paid.join(', ')} without going through ${METERED_HELPER_NAMES}.\n` +
          `    A money call with no per-company ceiling in front of it, whatever the route above it is named.`,
      );
    }
  }

  const routes = listRouteFiles(appDir).filter(isMeteredRoute);
  const covered = [];
  for (const file of routes) {
    const key = rel(file);
    const src = stripComments(readFileSync(file, 'utf8'));
    const methods = exportedMethods(src);
    if (!methods.includes('POST')) {
      failures.push(`${key}\n    is in a metered directory but exports no POST handler — is it a route at all?`);
      continue;
    }
    const imported = requestFunctionsOf(src).filter((n) => n.endsWith('ForRequest'));
    if (imported.length === 0) {
      failures.push(`${key}\n    calls no *ForRequest function from companies-request, so nothing here goes through the company ceiling.`);
      continue;
    }
    const compliant = [];
    for (const name of imported) {
      const body = functionBody(requestSource, name);
      if (body === null) {
        failures.push(`${key}\n    imports ${name}, which is not an exported function in ${rel(requestModule)}.`);
        continue;
      }
      let ok = true;
      if (!goesThroughMeteredHelper(body)) {
        failures.push(`${key}\n    ${name} calls neither ${METERED_HELPER_NAMES} — a paid call with no per-company ceiling in front of it.`);
        ok = false;
      }
      if (body.includes(`${UNMETERED_HELPER}(`)) {
        failures.push(`${key}\n    ${name} calls ${UNMETERED_HELPER}, the UNMETERED resolver — the company ceiling is being skipped.`);
        ok = false;
      }
      if (!body.includes('callMetered(')) {
        failures.push(`${key}\n    ${name} does not invoke the use case through callMetered, so an unconfigured gateway becomes an anonymous 500.`);
        ok = false;
      }
      if (ok) compliant.push(name);
      covered.push(`${key} → ${name}`);
    }

    /**
     * IMPORTING IS NOT CALLING, AND POST IS NOT THE ONLY METHOD.
     *
     * Both holes were demonstrated against this checker: a handler that imported the compliant function, assigned
     * it to an unused export to satisfy the linter, and then called the runtime directly; and a compliant POST
     * sitting beside an unmetered PUT in the same file. Every exported method is now required to actually invoke
     * one of the verified functions.
     */
    for (const method of methods) {
      const handler = functionBody(src, method);
      if (handler === null) {
        failures.push(`${key}\n    its ${method} export could not be read as a top-level function, so it has not been checked — and unchecked is not the same as safe.`);
        continue;
      }
      if (!compliant.some((n) => handler.includes(`${n}(`))) {
        failures.push(
          `${key}\n    its ${method} handler never calls any verified metered function (imported: ${imported.join(', ') || 'none'}).\n` +
            `    Importing one is not calling one: this handler reaches the paid path by some other route.`,
        );
      }
    }
  }

  // The floor. An empty or shrunken walk is a FAILURE, never a pass: this is the assertion that stops a rename
  // from silently converting the whole check into one that cannot fail.
  if (routes.length < EXPECTED_MINIMUM) {
    failures.push(
      `discovered ${routes.length} metered route(s), expected at least ${EXPECTED_MINIMUM}.\n` +
        `    Either a money route was deleted, or the walk stopped finding them — and a check that finds nothing\n` +
        `    must never report success (CDR-092 §7.5).`,
    );
  }
  const found = new Set(routes.map(rel));
  for (const expected of EXPECTED_ROUTES) {
    if (!found.has(expected)) failures.push(`the known metered route ${expected} was not discovered — deleted, renamed, or moved out of the walk.`);
  }

  return { code: failures.length > 0 ? 1 : 0, blind: [], failures, covered };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const selfProblems = selfTest();
  if (selfProblems.length > 0) {
    console.error('✖ generate-route coverage check FAILED ITS OWN SELF-TEST — its verdicts below would mean nothing.');
    for (const p of selfProblems) console.error(`  ${p}`);
    process.exit(1);
  }
  const { code, blind, failures, covered } = check();
  if (code === 2) {
    console.error('✖ generate-route coverage check COULD NOT RUN — it cannot see what it is meant to check.');
    for (const b of blind) console.error(`  ${b}`);
    console.error('  Exiting 2 rather than 0: a missing target is not evidence that everything is fine.');
    process.exit(2);
  }
  if (code === 1) {
    console.error(`✖ generate-route coverage check FAILED — ${failures.length} problem(s).`);
    console.error('  Every route that causes a PAID provider call must reach the per-company ceiling through');
    console.error('  resolveMeteredContext before the use case runs (ACBP-API-008; CDR-092 §2, §6.2).');
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`✔ generate-route coverage check passed (${covered.length} metered handler(s) reach the company ceiling). Self-test passed.`);
  for (const c of covered) console.log(`    ${c}`);
}
