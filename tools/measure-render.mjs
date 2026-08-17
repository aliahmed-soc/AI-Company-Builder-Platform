#!/usr/bin/env node
/*
 * measure-render.mjs — a rendered-page harness that can say NO.
 *
 * WHY THIS EXISTS. A screenshot is a check that cannot fail. Every defect this harness was written in response
 * to was invisible in a picture that looked correct:
 *
 *   - a 48px horizontal overflow (no `box-sizing: border-box` anywhere in the app) reads as a bad crop;
 *   - a missing viewport meta tag reads as "the desktop layout", because the narrow render never happened;
 *   - a reduced-motion comparison that silently tested the SAME condition twice reads as a perfect match.
 *
 * So this asserts numbers and exits non-zero, instead of producing images for someone to squint at.
 *
 * NOT WIRED INTO CI, DELIBERATELY. It drives a real Chrome against a running server, which the verification
 * gate does not provision; adding that to CI is a change with its own cost and belongs to its own decision, not
 * to a layout slice. It is a manual harness — but a committed one, so that a comment elsewhere in the tree can
 * name it as the enforcement for a claim, and so a reviewer can re-run the exact check rather than trust a
 * screenshot. If it is ever wired in, the checks below are already the assertions.
 *
 * USAGE
 *   1. Build and start the app (a production build, so no dev overlay is in frame):
 *        pnpm --filter @acbp/web run build
 *        pnpm --filter @acbp/web exec next start --port 3200
 *   2. node tools/measure-render.mjs <output-dir> [origin]
 *
 * Chrome is located from CHROME_PATH, then the usual Windows/macOS/Linux install paths.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!CHROME) {
  console.error('No Chrome found. Set CHROME_PATH to a Chrome/Chromium binary.');
  process.exit(2);
}

const OUT = process.argv[2] ?? 'render-measurements';
const ORIGIN = process.argv[3] ?? 'http://localhost:3200';
mkdirSync(OUT, { recursive: true });

/*
 * `expectHeader` encodes the point of the root-layout slice: `/console` must NOT inherit the ACBP-P1-001 auth
 * placeholder header, and the `(site)` pages must still render it, unchanged. Asserting the count in both
 * directions is what makes this a test rather than an observation — a change that removed the header from
 * EVERY page would look identical on the console screenshot alone.
 */
const PAGES = [
  { path: '/console', slug: 'console', expectHeader: false, isConsole: true, shot: true },
  // ACBP-FE-004. Without a real session this renders the `unauthenticated` refusal — which is a REAL state of
  // the real page, not a stub, and is exactly what it must show to a signed-out visitor.
  { path: '/console/companies', slug: 'companies', expectHeader: false, isConsole: true, shot: true },
  // ACBP-FE-006. The id is arbitrary because it is only a SELECTOR — @acbp/core re-validates it against an
  // active membership, so without a session this renders the `unauthenticated` refusal regardless of what is
  // in the path. That is the real page in a real state, and it still has to lay out correctly.
  { path: '/console/companies/cmp_layout_probe', slug: 'company', expectHeader: false, isConsole: true, shot: true },
  // ACBP-FE-005. The creation form is the FIRST page in this console with text inputs, a textarea and radios,
  // and inputs are the classic source of horizontal overflow: a `width: 100%` field inside a padded grid track
  // overflows unless `min-width: 0` and `box-sizing` are both right. Measuring it at 492 is the point.
  { path: '/console/companies/new', slug: 'newcompany', expectHeader: false, isConsole: true, shot: true },
  // ACBP-FE-005. Signed out this renders the provisioning refusal — a real state of the real page. The stepper
  // itself is only reachable with a session, so what this measures is the refusal's layout; the stepper's own
  // layout is covered by the narrow-width rules and by unit tests over the view, and that limit is stated in
  // the PR rather than implied to be full coverage.
  { path: '/console/companies/cmp_layout_probe/provisioning', slug: 'provisioning', expectHeader: false, isConsole: true, shot: true },
  { path: '/sign-in', slug: 'signin', expectHeader: true, isConsole: false, shot: true },
  { path: '/', slug: 'home', expectHeader: true, isConsole: false, shot: false },
];

/*
 * 900 sits BETWEEN the two breakpoints on purpose: it must already be the collapsed shell (<= 960) while still
 * being a wide window, which catches a rule that only happens to work at the bottom of the range. 492 is the
 * narrowest honest render available — Chrome on Windows refuses to open a window thinner than about that, and
 * the device-metrics override that would bypass the floor was measured NOT to take effect in this build.
 */
const WIDTHS = [
  { w: 1440, h: 1000, label: 'desktop', narrow: false },
  { w: 900, h: 1000, label: 'tablet', narrow: true },
  { w: 492, h: 900, label: 'narrow', narrow: true },
];

let failures = 0;
let nextPort = 9500;

function attach(ws) {
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id === undefined) return;
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
    else p.res(msg.result);
  };
  return (method, params = {}, sessionId) =>
    new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
}

async function render({ page, width, reduced, capture }) {
  const port = nextPort++;
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--force-device-scale-factor=2',
      `--window-size=${width.w},${width.h}`,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${(process.env.TEMP ?? '/tmp')}/acbp-measure-${port}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let wsUrl;
  for (let t = 0; t < 80; t++) {
    try {
      wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
      break;
    } catch {
      await sleep(250);
    }
  }
  if (!wsUrl) throw new Error(`Chrome never opened debugging port ${port}`);

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  const send = attach(ws);

  const targets = (await send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page');
  const { sessionId } = await send('Target.attachToTarget', { targetId: targets[0].targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);

  // A Clerk DEVELOPMENT instance redirects real document requests to a handshake when this dev-browser cookie
  // is absent, so without it every capture is a photograph of Clerk's error page. Only presence is checked, so
  // the value is arbitrary and carries no credential.
  await send(
    'Network.setCookie',
    { name: '__clerk_db_jwt', value: 'dvb_render_harness', domain: 'localhost', path: '/' },
    sessionId,
  );

  // BOTH directions are set EXPLICITLY. Headless Chrome reports `prefers-reduced-motion: reduce` by DEFAULT, so
  // leaving the "normal" run unset measures the reduced condition twice and every comparison then matches for
  // the wrong reason. That trap produced a full round of worthless evidence once; it does not get a second go.
  await send(
    'Emulation.setEmulatedMedia',
    { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] },
    sessionId,
  );

  await send('Page.navigate', { url: ORIGIN + page.path }, sessionId);
  await sleep(4000); // hydration + the 900ms counter + the staggered card entrance

  const ev = async (expr) =>
    (await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId)).result.value;

  const m = {
    innerWidth: await ev('window.innerWidth'),
    scrollWidth: Math.ceil(await ev('document.documentElement.scrollWidth')),
    contentHeight: Math.ceil(await ev('document.documentElement.scrollHeight')),
    matchMedia: await ev(`window.matchMedia('(prefers-reduced-motion: reduce)').matches`),
    tBase: await ev(`getComputedStyle(document.documentElement).getPropertyValue('--t-base').trim() || '(unset)'`),
    // DIRECT children of body only: the console's own top bar is nested far deeper and must not be counted.
    bodyHeaders: await ev('document.querySelectorAll("body > header").length'),
    headerText: await ev('(document.querySelector("body > header")?.textContent ?? "").trim().slice(0, 40)'),
    shellColumns: await ev(
      '(() => { const s = document.querySelector(".cs-shell"); return s ? getComputedStyle(s).gridTemplateColumns : "(no shell)"; })()',
    ),
    counter: await ev('document.querySelector(".cs-stat-value")?.textContent ?? "(none)"'),
    viewportMeta: await ev('document.querySelector("meta[name=viewport]")?.getAttribute("content") ?? "(MISSING)"'),
  };

  if (capture) {
    const { data } = await send(
      'Page.captureScreenshot',
      {
        format: 'png',
        captureBeyondViewport: true,
        // Pinned to the width the page ACTUALLY laid out at: `captureBeyondViewport` alone expands the capture
        // surface past the window, which once produced a "mobile" image 1395px wide.
        clip: { x: 0, y: 0, width: m.innerWidth, height: m.contentHeight, scale: 1 },
      },
      sessionId,
    );
    m.file = `${page.slug}-${width.label}.png`;
    writeFileSync(`${OUT}/${m.file}`, Buffer.from(data, 'base64'));
  }

  ws.close();
  chrome.kill();
  await sleep(300);
  return m;
}

function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

for (const page of PAGES) {
  console.log(`\n================ ${page.path} ================`);
  for (const width of WIDTHS) {
    const m = await render({ page, width, reduced: false, capture: page.shot });
    console.log(
      `\n[${width.label}] asked ${width.w} -> innerWidth ${m.innerWidth}, scrollWidth ${m.scrollWidth}, height ${m.contentHeight}` +
        `\n         viewport meta: ${m.viewportMeta}` +
        `\n         shell columns: ${m.shellColumns}` +
        `\n         body>header:   ${m.bodyHeaders}${m.bodyHeaders ? ' ("' + m.headerText + '")' : ''}`,
    );

    check(
      `${page.path} @${width.label}: no horizontal overflow`,
      m.scrollWidth <= m.innerWidth + 1,
      `scrollWidth ${m.scrollWidth} vs innerWidth ${m.innerWidth}`,
    );
    check(`${page.path} @${width.label}: viewport meta present`, m.viewportMeta.includes('device-width'), m.viewportMeta);
    check(
      `${page.path} @${width.label}: auth header ${page.expectHeader ? 'present' : 'ABSENT'}`,
      page.expectHeader ? m.bodyHeaders === 1 : m.bodyHeaders === 0,
      `body > header count = ${m.bodyHeaders}`,
    );
    if (page.expectHeader) {
      check(
        `${page.path} @${width.label}: auth header content unchanged`,
        m.headerText.includes('ACBP') && m.headerText.includes('Sign in'),
        `"${m.headerText}"`,
      );
    }
    if (page.isConsole) {
      // One grid track at narrow widths and two at desktop is direct proof the collapsed shell is really in
      // effect, rather than merely having been requested.
      const oneTrack = m.shellColumns.trim().split(/\s+/).length === 1;
      check(
        `${page.path} @${width.label}: shell is ${width.narrow ? 'collapsed (1 track)' : 'sidebar+main (2 tracks)'}`,
        width.narrow ? oneTrack : !oneTrack,
        m.shellColumns,
      );
    }
  }
}

console.log(`\n================ reduced-motion discrimination (/console @desktop) ================`);
const normal = await render({ page: PAGES[0], width: WIDTHS[0], reduced: false, capture: false });
const reduced = await render({ page: PAGES[0], width: WIDTHS[0], reduced: true, capture: false });
console.log(`                     normal | reduced`);
console.log(`matchMedia reduce  : ${String(normal.matchMedia).padEnd(6)} | ${reduced.matchMedia}`);
console.log(`computed --t-base  : ${String(normal.tBase).padEnd(6)} | ${reduced.tBase}`);
console.log(`counter at rest    : ${String(normal.counter).padEnd(6)} | ${reduced.counter}`);
check('motion emulation applied in BOTH directions', normal.matchMedia === false && reduced.matchMedia === true);
check('CSS reduced-motion block fires', normal.tBase === '240ms' && reduced.tBase === '0ms');
check('both conditions settle on the true value', normal.counter === reduced.counter && normal.counter !== '(none)');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
