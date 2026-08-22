// Regression suite for `tools/check-rate-limit-coverage.mjs` — specifically its HANDLER DETECTOR.
//
// ⚠️ THE CASE THIS EXISTS FOR WAS MEASURED, NOT IMAGINED. The detector matched only `export function GET`.
// Dropping a route exporting `export const GET = async () => …`, with no enforcement import at all, into
// `apps/web/src/app/api` left the handler count UNCHANGED at 45 and the check exited 0. The unlimited route was
// not failed — it was INVISIBLE.
//
// The zero-handler floor inside the checker cannot catch that: the other 45 routes still match, so the walk never
// looks empty. A detector narrower than the thing it detects does not report a smaller problem; it reports none.
//
// This is the third instance of that shape in one week — `check-generate-route-coverage` keyed on a `*ForRequest`
// naming convention a one-word rename defeated, and a CSS guard called `--danger` defined because it is a suffix
// of `--c-danger`. So the detector is pinned here against every export form Next.js accepts.
import { describe, test, expect } from 'vitest';
import { exportedMethods } from '../check-rate-limit-coverage.mjs';

describe('every form Next.js accepts as a route handler is SEEN', () => {
  // If any of these regress, a real route becomes invisible and ships unmetered.
  test.each([
    ['export async function GET(req) {}', 'GET', 'async function declaration'],
    ['export function POST(req) {}', 'POST', 'sync function declaration'],
    ['export const GET = async () => new Response("x");', 'GET', 'const arrow — THE FORM THAT WAS INVISIBLE'],
    ['export const POST = handler;', 'POST', 'const alias to a shared handler'],
    ["export { GET } from './shared.js';", 'GET', 're-export from another module'],
    ['const PATCH = () => {};\nexport { PATCH };', 'PATCH', 'declare then export in a list'],
    ['export let DELETE = handler;', 'DELETE', 'let binding'],
  ])('%s', (src, method) => {
    expect(exportedMethods(src)).toContain(method);
  });

  test('a module exporting several methods reports all of them', () => {
    const src = 'export async function GET() {}\nexport const POST = handler;\nexport { DELETE } from "./d.js";';
    expect(exportedMethods(src).sort()).toEqual(['DELETE', 'GET', 'POST']);
  });
});

describe('things that are NOT live handlers are not counted', () => {
  // The other half. A detector that fired on everything would satisfy the block above while failing every route
  // in the repository, which is the failure mode that gets a checker deleted rather than fixed.
  test.each([
    ['// export function GET() {}', 'line-commented handler'],
    ['/* export const POST = x; */', 'block-commented handler'],
    ['export function getThing() {}', 'lowercase name containing "get"'],
    ['function GET() {}', 'declared but never exported'],
    ['export const GETTER = 1;', 'longer identifier starting with GET'],
    ['export const POSTAL_CODE = "x";', 'longer identifier starting with POST'],
    ['const x = 1;', 'no exports at all'],
  ])('%s', (src) => {
    expect(exportedMethods(src)).toEqual([]);
  });

  test('a comment ABOUT this check does not register as a route', () => {
    // This file and the checker both contain the string `export function GET` inside prose. If comment
    // stripping regressed, the checker would count its own documentation as a handler.
    const src = '// This guard matches `export function GET` and `export const GET = …`.\nconst nothing = 1;';
    expect(exportedMethods(src)).toEqual([]);
  });
});

describe('the detector is anchored on the method name', () => {
  test('GET in one module does not imply POST', () => {
    expect(exportedMethods('export async function GET() {}')).toEqual(['GET']);
  });

  test('an unrelated HTTP-ish word in a string is not an export', () => {
    expect(exportedMethods('const method = "GET";')).toEqual([]);
  });
});
