# CDR-083 — Security response headers and Content Security Policy (ACBP-P7-015)

> **THE TICKET ID AND CDR NUMBER IN THIS DOCUMENT ARE PROVISIONAL, AND THE REASON IS AN OWNER DECISION.**
> **Three branches were built concurrently against the same CDR-080 §4 ruling, and all three claimed
> `ACBP-P7-013` and `CDR-081`:** PR **#78** `p7-013-csrf-origin-gate` (CSRF, `CDR-081-csrf-origin-gate.md`),
> PR **#79** `p7-013-http-rate-limiting` (rate limiting, `CDR-081-http-rate-limiting.md`), and this one. The
> collision was found by listing open PRs before committing, not by planning — the other two were opened while
> this branch was being written, and each is unaware of the others.
>
> This branch therefore stepped aside to **ACBP-P7-015** and **CDR-083**, leaving `P7-013`/`P7-014` and
> `CDR-081`/`CDR-082` for the other two.
>
> **THE TICKET-ID HALF IS NOW RESOLVED, verified against the branches rather than assumed.** The CSRF branch
> independently renumbered itself to **ACBP-P7-014** (`git show origin/p7-013-csrf-origin-gate:…/BACKLOG.csv`
> → `ACBP-P7-014`; its branch name keeps the old number), the rate-limiting branch kept **ACBP-P7-013**, and
> this one is **ACBP-P7-015**. Three ids, no overlap. The step-aside was a guess when it was made and it
> happens to have landed correctly.
>
> **THE CDR-NUMBER HALF IS NOT RESOLVED.** Both siblings still carry a `CDR-081-*.md` — different filenames,
> the same number — so one of them must still move. **`CDR-082` is deliberately left free for whichever one
> does**, which is why this document is `CDR-083` and not `CDR-082` despite the gap. That reassignment is the
> owner's call, not this ticket's.
>
> **There is also a real content conflict, not just a numbering one:** PR #78 rewrites `apps/web/src/proxy.ts`
> to add a CSRF gate, and this branch rewrites the same function to apply headers. The two changes compose
> cleanly in principle — their gate runs before the session is established, these headers wrap the response —
> but git will not merge them silently, and §6.4 records a substantive interaction between them.

Governing: **NFR-010** (security baseline / ASVS-aligned controls); ADR-006, ADR-022, ADR-023;
`docs/architecture/SECURITY-ARCHITECTURE.md §1`. Depends on **ACBP-P7-007** (security test pass), which
found this gap and — under the owner ruling recorded in **CDR-080 §4** — filed it as a finding with a
proposed implementation ticket rather than building it inside a verification pass. This is that ticket.

> **THIS TICKET STACKS ON AN UNMERGED BRANCH.** Branch `p7-013-security-headers-and-csp` is cut from
> `p7-007-security-test-pass`, **not** from `main`. Two things this ticket was told to do exist only there: the
> harness it extends (`apps/web/src/server/adversarial/secret-egress.test.ts`) and the downgraded NFR-010 rows
> it must amend. Basing on `main` would make both instructions unexecutable. The consequence is that **this PR
> cannot merge before ACBP-P7-007's**, and that ordering is the owner's to accept — it is stated here rather
> than discovered at merge time. (The branch was cut at `8d6e048` and **rebased onto `b958922`** when P7-007
> advanced mid-ticket — see §10 slice 8. Neither SHA is a durable anchor: if P7-007 is squash-merged and its
> branch deleted, as ACBP-P7-001 and ACBP-P7-002 were, both become unreachable. The durable fact is the
> dependency, not the commit.)

> **THIS DOCUMENT WAS CORRECTED BY TWO INDEPENDENT REVIEWS**, one on code and one on prose, run before anything
> was committed. They agreed on five defects and each found more alone. **The most serious was a security header
> this ticket had already shipped**, justified in four places by a claim about Clerk that cannot be established
> in this repository — §6.2 records it, because a removed control with the reasoning deleted is how the same
> header gets re-added next quarter. Every count and file:line below was re-derived rather than re-asserted.

---

## §0 What NFR-010 actually says, and which of these words are mine

This matters because the failure mode ACBP-P7-002 and ACBP-P7-007 were both written about is a claim that
reads like canon and is not. So, precisely:

**`REQUIREMENTS.csv` NFR-010, verbatim:**

> *"OWASP ASVS-aligned controls: input validation, output encoding, CSRF protection, rate limiting,
> dependency scanning in CI, and third-party pen review before public beta."*

**The literal clause list does NOT contain the words "security headers" or "Content Security Policy."**
What it contains is *output encoding* plus the umbrella phrase *ASVS-aligned*. Security headers and CSP
enter through that umbrella — ASVS V14.4 (HTTP security headers) and V5.3 (output encoding and injection
prevention, of which CSP is the defence-in-depth half). CDR-080 §4's summary — *"NFR-010's baseline names
CSRF protection, HTTP rate limiting, and security headers / CSP"* — is that mapping stated as if it were the
clause. It is a **defensible reading, not a quotation**, and this ticket does not inherit it silently.

**Consequence for scope:** this ticket delivers an ASVS V14.4-shaped control set. It does **not** claim to
close NFR-010, which also names input validation, CSRF, rate limiting and a pen review. Its traceability
edit says exactly that much and no more (§9).

---

## §1 Evidence of absence — the state before this branch

| Claim | How it was established |
|---|---|
| `apps/web` sends no security header of any kind | `grep -niE "x-content-type-options\|referrer-policy\|x-frame-options\|content-security-policy\|strict-transport\|permissions-policy\|nosniff"` over `apps packages tools docs` returns **one** hit, and it is a competitor audit note in `docs/research/polsia/raw-audit/22-exported-code-verification.md:29` — describing someone else's product |
| No header configuration exists | `apps/web/next.config.ts` has `typedRoutes`, `transpilePackages` and a webpack `extensionAlias` hook. No `headers()`, no `redirects()`, no `poweredByHeader` |
| No response-header code in the request path | `apps/web/src/proxy.ts` mounts `failClosed(clerkMiddleware())` and returns Clerk's response untouched; `fail-closed-proxy.ts` builds one `NextResponse.json` 401 with no headers |

---

## §2 Where headers belong IN THIS REPOSITORY — ruled, on evidence

There are exactly three places a Next.js app can set response headers, plus a fourth that people assume.
Each was checked against what this repository actually contains.

### §2.1 The fourth one first: a reverse proxy. **UNBUILDABLE HERE.**

The usual production answer — terminate TLS at the platform edge and set headers there — **cannot be written in
this repository, because this repository contains no deployment configuration at all.**

```
git ls-files | grep -iE "dockerfile|render\.yaml|fly\.toml|vercel\.json|terraform|\.tf$|infra/|k8s|helm|nginx|caddy|Procfile"
→ (zero matches)
```

`.github/workflows/` holds exactly one file, `ci.yml`, whose own header line reads *"checks only; runs no
releases and changes no environments."*

**The provider is nevertheless already chosen, and saying otherwise would overstate this.** **ADR-020
(Accepted)** selects **Render** — a Render web service for the app, a Render background worker, Render
PostgreSQL — and its own portability clause promises *"source-controlled deployment configuration **when
implementation begins**."* Implementation has not begun: there is no manifest, no environment, no region
selected (`AOQ-20` is still open) and no domain. **ACBP-P7-006** (`Planned`, governed by ADR-018/ADR-020) owns
creating the first one. So the accurate statement is not *"nobody knows where this will run"* — it is *"the
provider is decided and nothing about it is configured here yet"*, which is what makes the edge unavailable as
a home today and what makes §4's HSTS parameters unchooseable.

### §2.2 `next.config.ts` `headers()` — REJECTED, and the reason is verification, not correctness

On the merits this is the conventional home: it is declarative, and Next applies it to every response it
serves including static assets and 404s. It was rejected anyway, on one fact:

**Nothing in this repository can observe it.** `headers()` is honoured by the Next *server*. Asserting it
requires `next build` + `next start` + a real HTTP request. `ci.yml`'s steps are `ci:preflight`, a standalone
`check:secrets`, the aggregate `check`, `demo:slice-a` and `pnpm audit` — **none of them builds or starts the
web app**, and there is no harness that does. A test could import `next.config.ts` and assert the array it
returns, but that asserts the *config literal*, not a response; it would go green with a typo'd header name, a
bad `source` pattern, or a Next version that stopped reading the field.

A control whose only evidence is a config-shape assertion is precisely the artefact class ACBP-P7-002 was
written to destroy. Rejected for that reason and no other. If ACBP-P7-006 ever produces a running
deployment with an HTTP-level check, `headers()` becomes a reasonable *second* layer — §8 raises it.

It also cannot carry a per-request CSP nonce, which §3 needs.

### §2.3 Per-route — REJECTED

Route handlers can set their own headers, but the surfaces that need a CSP most are the **HTML pages**
(`app/page.tsx`, `app/layout.tsx`, `sign-in`, `sign-up`) — where scripts actually execute — and pages have
no header hook. Per-route would also put the same six-line block in 23 files, where the twenty-fourth is
the one that forgets.

### §2.4 `src/proxy.ts` (the Next 16 middleware) — CHOSEN

- It runs on every matched request, so one implementation covers **pages and API routes alike**.
- It covers responses that **`next.config.ts` cannot reach**: the `failClosed` 401 and Clerk's own redirects
  are generated *by* middleware, and next.config `headers()` are applied by the routing layer the request
  never gets to.
- It is per-request, which is what a CSP nonce requires (§3).
- **It can be driven directly by a test** — `import proxy from '@/proxy'` and call it. That is the property
  that makes the evidence in §7 a response assertion rather than a config assertion, and it is why the
  ACBP-P7-007 harness can be extended at all.

**What the proxy does not cover, stated rather than glossed:**

1. **Static assets.** The matcher excludes `_next` and file extensions. In this app that costs nothing
   measurable: `apps/web/public` **does not exist**, so the only static output is Next's own build artefacts
   — its own JS and CSS, served with correct content types and no user-controlled bytes.
2. **The Clerk webhook route.** `proxy.ts` returns `undefined` for `isClerkWebhookPath(...)`, deliberately
   (ACBP-P1-002 slice 3: a stray cookie must never 401 an authentic signed webhook). Headers are **not**
   added there. Rationale: it is a machine-to-machine endpoint with no browser, no HTML and no script
   execution, so every header in §6 is inert on it — and buying nothing is not worth editing a proven
   auth-bypass path. **This exception is asserted explicitly in §7 so it stays a decision and does not decay
   into an oversight.**

---

## §3 What a CSP can be here without breaking Clerk — established from the installed package

Clerk injects its own scripts, iframes and styles, so a CSP written by hand against `clerk.com` docs is a
guess. It did not need to be one: **`@clerk/nextjs@7.5.20` generates a Clerk-compatible CSP itself.**

`node_modules/@clerk/nextjs/dist/types/server/clerkMiddleware.d.ts` declares
`contentSecurityPolicy?: ContentSecurityPolicyOptions` on `ClerkMiddlewareOptions`, with `strict`,
`directives`, `reportOnly` and `reportTo`. The generator is
`dist/esm/server/content-security-policy.js`. Four findings from reading it, each of which changed a
decision below:

**(a) The non-strict default policy is worth almost nothing.** `DEFAULT_DIRECTIVES['script-src']` **contains**
`'self' 'unsafe-inline' https: http:` (plus `'unsafe-eval'` when `NODE_ENV !== 'production'`, and three
Stripe/Maps hosts that `https:` already subsumes — *contains*, not *is*, because the list is longer than the
part that matters). A policy permitting any script over http *or* https *and* inline script does not constrain
XSS in any useful way.
Turning CSP on in the default mode would install a header that **looks** like a control and is not — the
exact shape of finding this ticket's parent exists to catch. **`strict: true` is therefore mandatory, not
an enhancement.** Strict deletes `https:` and `http:` and adds `'strict-dynamic'` plus a fresh
`'nonce-…'`. (`'unsafe-inline'` remains in the list and is correct: CSP3 requires browsers to ignore it
when a nonce or `'strict-dynamic'` is present, which is the documented backwards-compatibility mechanism.)

**(b) Three non-fallback directives are absent from Clerk's defaults.** The generated set is `connect-src`,
`default-src`, `form-action`, `frame-src`, `img-src`, `script-src`, `style-src`, `worker-src`.
**`frame-ancestors`, `base-uri` and `object-src` are not in it.** The first two do not fall back to
`default-src` at all, so they would be *unrestricted*; `object-src` falls back to `default-src 'self'`,
which still permits same-origin plugin content. All three are supplied through the `directives` option in
§6.

**(c) The nonce survives report-only mode — verified in Next, not assumed.** The concern with report-only
was that Clerk emits `content-security-policy-report-only`, while Next extracts its script nonce from the
enforcing header — which would mean Next's own scripts carry no nonce, and a strict report-only run would
report a violation for every framework script and drown the real signal. **That is not what Next 16.2.11
does.** `next/dist/server/app-render/app-render.js:167` reads:

```js
const csp = headers['content-security-policy'] || headers['content-security-policy-report-only'];
```

Clerk forwards its generated header onto the *request* as well as the response
(`setRequestHeadersOnNextResponse`, `clerkMiddleware.js:267`), so Next sees it and nonces its own scripts
either way. Strict report-only is therefore **informative here**, not noise.

**(d) Clerk's defaults carry hosts this product does not use** — `api.stripe.com`, `js.stripe.com`,
`*.js.stripe.com`, `hooks.stripe.com`, `maps.googleapis.com`, `images.clerkstage.dev`. The `directives` option
**merges** into the default sets, so they cannot be removed *selectively*. One escape hatch does exist and is
worth naming rather than implying none: `handleExistingDirective` short-circuits on `'none'`, replacing a
directive wholesale — but `script-src 'none'` or `frame-src 'none'` would break the app and Turnstile, so it is
not usable here. In report-only these hosts permit nothing. Recorded as known slack in the emitted policy, and
as an owner decision (§8) for the enforcing switch.

### §3.1 Report-only, and the honest limit of that word

The policy ships as **`Content-Security-Policy-Report-Only`**. The user-facing reason is the obvious one: a
CSP that breaks sign-in gets reverted within a day, so it does not get to be enforcing on the first commit.

The limit worth stating: **`reportTo` is not set, because no reporting endpoint exists.** Building one
means a new public unauthenticated route that accepts POSTed JSON from browsers, plus somewhere to put it,
plus a rate limit on it — a ticket, not a line. Without it, violations surface **in the browser console
only**. So the accurate sentence is *"the policy is published and not enforced, and violations are visible
to whoever opens devtools"* — **not** *"we are collecting CSP reports."* §8 raises the endpoint.

---

## §4 HSTS — NOT SHIPPED, and the check that decided it

`Strict-Transport-Security` instructs a browser to refuse plaintext HTTP to an origin for `max-age`
seconds. It is meaningful only where the response is actually delivered over TLS.

**There is no TLS termination this repository controls, and no environment to control it in.** §2.1 is the
evidence, and its correction is the point: **ADR-020 has already chosen Render**, which does terminate TLS at
its edge — so the honest objection is *not* "we have no idea where this runs". It is that ADR-020's deployment
configuration is explicitly deferred to *"when implementation begins"*, and it has not: no manifest, no
environment, no region (`AOQ-20` open), no domain. `pnpm dev:web` serves `http://localhost:3000`.

An app-level `Strict-Transport-Security` header is a legitimate pattern *behind* a TLS-terminating proxy, and
Render will be one. But the parameters that make it safe or dangerous cannot be chosen without the thing that
does not exist yet: `includeSubDomains` is a commitment about sibling hostnames of an unregistered domain,
`preload` is effectively irreversible, and `max-age` is a promise about a host nobody has provisioned. Nor
could anything here verify the header is delivered — §2.2's reason, one layer out.

`DEPLOYMENT-ARCHITECTURE.md` assigns TLS, certificates and edge headers to nobody: `grep -niE
"tls|https|header|hsts|certificate"` over it returns one hit, about generated-application trust zones. So HSTS
has no documented owner today either, which is the second half of why this ticket declines to invent one.

**Ruled: no HSTS in this ticket.** It is recorded as a named, deferred obligation of **ACBP-P7-006**
(staging validation), which owns the first environment that can carry TLS, and it is written into the
NFR-010 gap cell (§9) so it is visible rather than merely absent. §7's test pins the *absence* as
deliberate, so a future author adds it by amending a decision rather than by patching a silent omission.

---

## §5 What this ticket CANNOT deliver

| Not deliverable | Why |
|---|---|
| HSTS | §4. ADR-020 picks Render, but no deployment configuration, environment or domain exists, so the parameters cannot be chosen and delivery cannot be verified. |
| **`Cross-Origin-Opener-Policy`** | §6.2. It was shipped, then **removed under review**: the justification rests on whether Clerk uses the popup OAuth flow, which cannot be established here, and the fuller analysis points at COOP *causing* the popup breakage it was claimed to prevent. COOP is enforcing, so unlike the CSP it cannot be published and then corrected. |
| An **enforcing** CSP | Would need at minimum one manual sign-in/sign-up pass against a real Clerk instance to confirm nothing breaks. That is a Clerk dashboard credential and a running app — owner gate. §8. |
| CSP violation **collection** | No reporting endpoint; building one is a new public route plus storage plus its own rate limit. §3.1. |
| `Cross-Origin-Embedder-Policy` | COEP requires every cross-origin subresource to opt in via CORP or CORS. Clerk's scripts, images (`img.clerk.com`) and Turnstile frames are third-party and do not. Enabling it breaks sign-in outright. Deliberately excluded, not overlooked. |
| Headers on static assets and on the Clerk webhook route | §2.4. Both bounded and both stated. |
| Any evidence from a **running** web server | CI never runs `next build`/`next start`. Every assertion in §7 drives the exported proxy function in-process. That is a real response object from the real middleware, and it is **not** an HTTP-level end-to-end proof. Two consequences are named rather than left implicit: (a) nothing here proves Next's `matcher` routes these paths through the proxy at runtime; (b) **for pages, what is proven is that the headers are on the `NextResponse.next()` sentinel the middleware returns** — that Next then merges them onto the eventual HTML document is standard framework behaviour, but no assertion on this branch touches that step. |
| Per-surface coverage, as opposed to per-surface *execution* | `clerkMiddleware` is called with **no handler**, so it performs no route matching, and the only path-dependent branch in the whole boundary is `isClerkWebhookPath`. The sweep therefore executes one proposition 25 times: *"the boundary headers any input that is not the webhook path."* That is worth having — it is what catches a future second bypass — but it is one proposition, not 25. |
| Closing NFR-010 | §0. Input validation, CSRF, rate limiting and the pen review are untouched by this ticket. |

---

## §6 The header set, and what each one is for

Applied by `apps/web/src/server/http/security-headers.ts`, a provider-neutral pure function, from
`proxy.ts`. Each entry had to justify both its presence and its exact value.

| Header | Value | Why this value |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | Stops MIME sniffing turning a JSON error body into executable script. Zero compatibility cost. |
| `Referrer-Policy` | `no-referrer` | **Load-bearing for tenancy.** Company identifiers sit in URL paths (`/api/companies/{companyId}/…`). `strict-origin-when-cross-origin` — the modern browser default — still leaks the origin; `no-referrer` sends nothing. No integration in this app reads `Referer`. **It also constrains the CSRF ticket — see §6.4.** |
| `X-Frame-Options` | `DENY` | The actual clickjacking control. CSP `frame-ancestors` is the modern equivalent, but it is **not enforced in a report-only policy**, so while §3 stays report-only this header is what enforces. Note `DENY` also forbids *same-origin* framing; Clerk's own default CSP ships `frame-src 'self'`, so if Clerk proxy mode or any same-origin Clerk iframe is ever enabled, this must become `SAMEORIGIN`. Not a problem today — `CLERK_PROXY_URL`/`proxyUrl`/`isSatellite` appear nowhere in `apps/` or `packages/`. |
| `Cross-Origin-Resource-Policy` | `same-origin` | Blocks cross-origin pages embedding this app's authenticated responses as images/scripts. Nothing here is meant to be embedded: `apps/web/public` does not exist, there is no OG-image or manifest route, and all 23 route handlers are same-origin app APIs. CORP does not affect `fetch`/XHR (that is CORS), only `no-cors` subresource loads. |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | Deliberately **short**. A blanket deny-list would eventually catch `publickey-credentials-get`/`-create`, which Clerk needs for passkeys — a header that silently disables a sign-in factor is the §3(a) failure in another costume. These three are provably unused by this product and by Clerk's flows. |
| `Content-Security-Policy-Report-Only` | Clerk `strict: true` + §6.1 | §3. |

`X-XSS-Protection` is excluded on purpose: it is deprecated and its filter was removed from every current
browser.

### §6.1 The `directives` supplied to Clerk

```
frame-ancestors 'none'   — non-fallback, absent from Clerk's defaults (§3b); the CSP twin of X-Frame-Options
base-uri        'self'   — non-fallback, absent from Clerk's defaults; blocks <base href> hijacking of relative script URLs
object-src      'none'   — would otherwise fall back to default-src 'self'; no plugin content exists in this app
form-action     'self'   — already 'self' in Clerk's defaults; restated so that a Clerk default change is a visible diff here rather than a silent widening
```

### §6.2 `Cross-Origin-Opener-Policy` — SHIPPED, THEN REMOVED UNDER REVIEW

The table above originally carried `cross-origin-opener-policy: same-origin-allow-popups`, justified in four
places — the module, the unit test's name, this section, and the backlog row — with one sentence: *"Clerk's
OAuth/social sign-in opens a popup and `postMessage`s back to `window.opener`; `same-origin` severs that
reference and breaks social sign-in."* An independent review took it apart, and it does not survive.

**The premise is not establishable in this repository.** `@clerk/clerk-js` — the package that would contain the
popup logic — **is not installed**; only `@clerk/nextjs` is, and `grep -rn "opener\|window.open"` over its
`dist/esm/` returns nothing. `sign-in/[[...sign-in]]/page.tsx` renders a bare `<SignIn />` with no `oauthFlow`
prop, and no social provider is configured anywhere in code. Whether a popup is ever opened is a property of a
Clerk dashboard configuration and a runtime bundle, neither of which exists here.

**And the fuller analysis points the other way.** `same-origin-allow-popups` protects the opener→popup link
only while the popup's own document sends `unsafe-none`. An OAuth popup navigates `about:blank → provider
(cross-origin, `unsafe-none`) → this app's callback`. That last navigation compares `unsafe-none` against
`same-origin-allow-popups`, which fails the COOP match, forces a browsing-context-group switch, and leaves
`window.opener` **null** in the popup. The conventional mitigation is to send *no* COOP on the callback route
specifically. This middleware sent it on every path including `/sign-in/*`. **So the header as shipped was a
plausible cause of the exact failure it claimed to prevent.**

**Ruled: not shipped.** The deciding property is that **COOP is ENFORCING.** The CSP is report-only precisely
because a control that can break sign-in must be publishable and correctable; COOP has no such mode. Shipping
an enforcing control on a premise this repository cannot check, with a failure mode of *sign-in hangs with no
actionable error*, is the defect class ACBP-P7-007 exists to find — reproduced by the ticket meant to close one
of its findings. Its absence is asserted in both suites so it is a decision on the record, not a gap someone
re-fills by reflex, and §8 raises re-adding it as an owner decision with the two questions that must be
answered first.

### §6.3 `poweredByHeader: false` — the one change in `next.config.ts`, and the one thing here without evidence

Review found the earlier claim *"`X-Powered-By` is already off"* to be false in every clause. Next's default is
`poweredByHeader: true` (`next/dist/server/config-shared.js:101`), and `next/dist/server/send-payload.js:56`
sets `X-Powered-By: Next.js` on responses whose content type is HTML — i.e. exactly the page surfaces this
ticket is about, not, as the earlier text asserted, on responses the middleware layer does not produce.

`apps/web/next.config.ts` now sets `poweredByHeader: false`. **This is the only header decision in the ticket
with no response assertion behind it**, for §2.2's reason — CI never serves a response, so nothing here can
observe it — and it is also the only place it *can* be done, because the header is added when the payload is
sent, long after middleware has returned. It is a one-line removal of a framework-version disclosure with no
failure mode, which is worth doing on its own merits; it is **not** evidence, and it is not counted as such.

### §6.4 What `no-referrer` costs the CSRF ticket, written down before that ticket is written

The `Referrer-Policy` rationale above considers only the `Referer` header. Review found a second effect. Per the
Fetch standard's *"append a request `Origin` header"*, a referrer policy of `no-referrer` sets the serialized
origin to **`null`** for any request whose method is not GET/HEAD **and whose mode is not `cors`** — which is
HTML `<form method="post">` submission. Clerk's own calls are mode `cors` and still carry a real origin, so
nothing breaks today.

It matters because the conventional CSRF defence for Next is an `Origin`-header check. With `no-referrer` set
app-wide, a legitimate same-origin form POST arrives with `Origin: null` — and so does an attacker's
cross-origin form POST, since the attacker controls their own page's referrer policy. A check written to accept
`null` is not a check.

**And this is no longer hypothetical.** PR **#78** (`p7-013-csrf-origin-gate`) is open and does exactly this:
its `decideSameOrigin` reads `Sec-Fetch-Site` with an **`Origin` fallback**. Read against that design:

- Its **primary** signal, `Sec-Fetch-Site`, is unaffected by referrer policy. So `no-referrer` does **not**
  break that gate.
- Its **fallback** row is degraded: on a form POST from a browser that sent no `Sec-Fetch-Site`, the `Origin`
  it falls back to will be `null` rather than this app's origin. Per that branch's own stated posture —
  *"a misconfiguration degrades toward refusing state-changing requests, never toward accepting them"* — that
  fails **closed**, which is the safe direction. It is still a live interaction between two branches neither of
  which cites the other.

Recorded here in those terms so the two tickets can be reconciled deliberately rather than discovered at merge.

---

## §7 The evidence, and the guard that keeps it true

**Extends the ACBP-P7-007 harness rather than starting one.**
`apps/web/src/server/adversarial/secret-egress.test.ts` already discovers every `route.ts` under `app/`,
drives every exported HTTP method of all 23 modules with no database, and inspects response **headers** as
well as bodies. Its discovery, its dynamic-segment parameter table and its method list are lifted into
`apps/web/src/server/adversarial/route-inventory.ts` and shared, so there is exactly one definition of
"every route in this app" — two copies of a security sweep's discovery is how one copy silently stops
finding things.

**That sharing has a cost, and it should be stated rather than left for someone to find.** `route-inventory.ts`
is now a dependency of a **trust-critical** suite (#15, secret egress), so a defect in it degrades that suite as
well as this one. What makes the coupling survivable is that **each suite keeps its own independent on-disk
walk** to check the shared discovery against — `secret-egress.test.ts` already had one, and §7.4 is this
suite's, added under review precisely because the first version did not have it. Neither suite trusts the shared
module to tell it what exists; both verify it. `secret-egress.test.ts` also still builds its own request URLs
and never calls `routePathFor`, so the path-construction changes in §7.5 cannot reach it. Its six tests pass
unchanged.

`apps/web/src/server/adversarial/security-headers.test.ts` then does the following. **The seven numbered items
below are §7.1 to §7.7**, and are cited by those numbers elsewhere in this document.

1. **Sweeps.** Drives `proxy.ts` — the real exported middleware — at every discovered route path *and* every
   discovered page path, asserting the full §6 set on each response. There are 23 route handlers and **three**
   pages (`/`, `/sign-in`, `/sign-up`); `/auth-check` is a `route.ts`, not a page, and is reached through route
   discovery. What this does and does not prove is bounded in §5, including the page-propagation step.
2. **Proves it can fail.** An anti-vacuity control: a response built with the headers deliberately missing
   is fed to the same detector, which must name every missing header, and a second control pins that a
   correct-but-wrong-*valued* header is caught too. Without these, a broken detector and a sound product are
   indistinguishable — ACBP-P7-007 §0.1 found two assertions in this repository that were unconditionally true,
   and this suite refuses to be the third.
3. **Pins the exceptions.** The Clerk webhook path is asserted to be the *only* path without headers, and
   HSTS, COEP and COOP are asserted **absent on every path**. Those are the §2.4, §4, §5 and §6.2 decisions; an
   assertion is what stops them decaying into forgotten omissions.
4. **Guards discovery against a second, independent walk.** *This is the part review rewrote.* The first
   version compared the swept set against `ALL_PATHS()` — but the swept set was **built** from `ALL_PATHS()`,
   so the two sides could not disagree about discovery, and a `discoverPageFiles()` that silently returned two
   of three pages left all tests green. The guard now re-walks the tree with a matcher written separately from
   the one under test, exactly as `secret-egress.test.ts` already did, and compares. **Verified by mutation:**
   `discoverFiles(PAGE_FILE).slice(1)` now fails with `expected [ …(25) ] to deeply equal [ …(26) ]`. A
   companion test keeps the second half of the property — that every discovered surface was actually driven.
   The floor moved from 24 to **26**, the true count, because at 24 two pages could vanish unnoticed.
5. **Discovers what Next actually routes, not what this app happens to use.** Also from review: matching the
   literal names `route.ts`/`page.tsx` made `foo/route.js` or a page renamed to `.jsx` invisible, and
   `routePathFor` passed route groups, parallel-route slots, intercepting routes and private folders through
   *literally* — turning `(marketing)/about/page.tsx` into the path `/(marketing)/about`, which the boundary
   would have headered happily while `/about` went undriven. Discovery now matches every routable extension and
   skips `_private` folders; path construction drops `(group)` and `@slot` segments, and **throws** on
   intercepting routes rather than guessing. Silence was the defect, so the unhandled shape shouts.
6. **Proves the CSP against Clerk's REAL generator.** `@clerk/nextjs/server` is **not mocked** in this suite.
   Clerk's request authentication reaches no network for a request carrying no session token, so the real
   `clerkMiddleware` runs offline with no database, and the five CSP assertions read
   `content-security-policy-report-only` straight off the response: the four §6.1 directives present, the
   enforcing header absent, `script-src` carrying `'strict-dynamic'` and a nonce with no blanket `https:`/
   `http:`, a *different* nonce on every request matching the `x-nonce` header, and the Frontend API host
   derived from the publishable key rather than hard-coded.
7. **Makes a Clerk option rename fail the typecheck** — the enforcement §6.2's lesson demanded be nameable.
   Every field of Clerk's `ContentSecurityPolicyOptions` is optional, so passing our object wholesale would
   typecheck even if Clerk deleted `reportOnly` (shipping the enforcing policy) or `strict` (shipping the
   worthless one). `proxy.ts` lists the fields in an **object literal**, where excess-property checking fires.
   **Verified by mutation:** renaming `reportOnly` to `reportingOnly` at that call site makes `tsc --noEmit`
   exit **2** with `TS2769 … Object literal may only specify known properties`; restored, it exits 0.

---

## §8 Open owner decisions

1. **Merge order.** This PR is stacked on ACBP-P7-007's and cannot merge first. Accept the stack, or have
   this ticket rebased onto `main` after P7-007 lands.
2. **When does the CSP become enforcing?** Requires a manual sign-in/sign-up pass against a real Clerk
   instance — a Clerk credential and a running app, both owner gates. Until then the policy is published
   and not enforced.
3. **A CSP reporting endpoint** (§3.1) — a new public unauthenticated route, storage, and a rate limit on
   it. Without it "report-only" means browser-console-only.
4. **Clerk's Stripe and Google Maps hosts** (§3d) in the emitted policy. Unremovable through the
   `directives` option and harmless while report-only; they become a real widening on the enforcing switch.
   Options: accept, pin a Clerk version and vendor the directive set, or stop using Clerk's generator.
5. **HSTS parameters** — deferred to ACBP-P7-006 (§4); `max-age`, `includeSubDomains` and `preload` cannot
   be chosen before a domain exists, and `preload` is effectively irreversible.
6. **A second layer in `next.config.ts`** (§2.2) once ACBP-P7-006 gives CI something to make an HTTP
   request against — it would cover static assets and the webhook route, which the proxy does not.
7. **The other two CDR-080 §4 findings are IN FLIGHT on other branches, not unfiled** — **ACBP-P7-014** on PR
   **#78** (`p7-013-csrf-origin-gate`, CSRF) and **ACBP-P7-013** on PR **#79** (`p7-013-http-rate-limiting`),
   both opened while this branch was being written. This ticket covers only the third finding. Three things
   follow, all owner decisions: *(a)* the **CDR-number** collision in the header note — both siblings still
   carry a `CDR-081`, and `CDR-082` is left free for whichever moves; *(b)* PR #78 and this PR both rewrite
   `apps/web/src/proxy.ts`, so one of them merges into a conflict; *(c)* §6.4's `no-referrer` / `Origin: null`
   interaction with #78's `Origin` fallback — it degrades that fallback closed rather than breaking it, but
   neither branch cites the other and the reconciliation should be deliberate.
8. **Should `Cross-Origin-Opener-Policy` be re-added?** (§6.2.) Two questions must be answered first, and
   neither can be answered in this repository: *(a)* does the Clerk configuration this product will actually
   use open an OAuth **popup**, or does it redirect? *(b)* if it popups, is the callback route exempted from
   COOP? Answering them needs a Clerk dashboard and a browser — owner gates both. Until then the header stays
   off and its absence stays asserted.
9. **The CSP nonce makes every page render unique.** Passing `contentSecurityPolicy` makes Clerk stamp a fresh
   per-request nonce into the HTML, so page output varies per request. Not a security problem, but it is a
   caching/rendering property nobody has decided on, and it arrived as a side effect of this ticket.
10. **`X-Frame-Options: DENY` forbids same-origin framing too.** Harmless today (`CLERK_PROXY_URL`/`proxyUrl`/
    `isSatellite` appear nowhere), but enabling Clerk proxy mode or any same-origin Clerk iframe would require
    `SAMEORIGIN`. Recorded so the breakage is diagnosable in one step rather than three.

---

## §9 Traceability edits

Before this branch the two NFR-010 rows read *"Partially covered - scan gates only (MVP)"* and *"Partially
covered - scan gates only"* respectively, with the gap named by ACBP-P7-007. **Every cell this ticket touches is
listed below** — an earlier draft of this section named two edits when there were seven, which is precisely the
under-reporting a traceability section exists to prevent.

`docs/architecture/REQUIREMENT-TRACEABILITY.csv`, row NFR-010 — four cells:

| Cell | Change |
|---|---|
| `Security control` | appends `; security response headers + report-only CSP` |
| `Verification approach` | appends `; middleware header sweep` |
| `Coverage status` | `Partially covered - scan gates only (MVP)` → `Partially covered - scan gates + response headers/CSP (MVP)` |
| `Gap or question` | the retained ACBP-P7-007 text is marked as the state **before** this ticket, and the appended text records what ACBP-P7-015 closed, that HSTS and COOP are deliberately unshipped, and that CSRF and rate limiting remain absent |

`docs/implementation/REQUIREMENT-TO-TICKET-TRACEABILITY.csv`, row NFR-010 — three cells: `Ticket IDs` gains
`ACBP-P7-015`; `Coverage status` takes the same rewording; `Gap or question` carries the same facts.

**The retained sentence had to be edited, not merely appended to.** Both cells said *"security headers/CSP are
ABSENT from apps/web"*. Appending *"ACBP-P7-015 closed the headers/CSP third"* below it left each cell asserting
the same control absent and present — a contradiction that would already be false the moment it was committed,
which is the exact stale-status defect recorded against ACBP-P7-002. The retained clause is now explicitly
historical. Its **attribution** is corrected too: §0 rules that NFR-010's literal clause list does not contain
"security headers" or "Content Security Policy", and it would be incoherent to argue that in §0 and then leave
the row this ticket edits republishing *"three ASVS baseline items **named by NFR-010**"*.

**Neither coverage status moves to `Covered`.** NFR-010 also names input validation, CSRF, rate limiting and
a third-party pen review; the pen review has not happened and two of the three ASVS findings are still open.
Moving the cell would recreate exactly the false *"Covered"* that CDR-080 §5 was written to correct.

---

## §10 Slices, and the mutations that prove the tests can fail

1. **CDR + branch** — **DONE.** This document.
2. **`route-inventory.ts`** — **DONE.** Discovery, the method list and the dynamic-segment table extracted from
   the ACBP-P7-007 harness and shared; `secret-egress.test.ts` refactored onto it. *Verified:* that suite's six
   tests still pass unchanged.
3. **`security-headers.ts` + `security-headers.test.ts` (unit)** — **DONE**, written test-first (the suite was
   run RED against a missing module before the module existed). **20 tests.**
4. **`proxy.ts` wiring** — **DONE.** `applySecurityHeaders` around every response the middleware returns, and
   `clerkMiddleware({ contentSecurityPolicy })` per §3/§6.1, passed as an object literal per §7.7.
5. **`adversarial/security-headers.test.ts`** — **DONE. 14 tests:** the sweep, the anti-vacuity controls, the
   pinned exceptions, the CSP assertions and the two source guards. Run RED (9 failing) before slice 4 wired
   the proxy.
6. **Traceability + backlog** — **DONE.** §9, plus the `ACBP-P7-015` backlog row.
7. **Two independent reviews, and the corrections they forced** — **DONE.** One on code, one on prose, both run
   before anything was committed. They agreed on five defects. The material ones: COOP was removed (§6.2), the
   source guard was rewritten because it guarded nothing (§7.4), discovery was widened to every routable
   extension and taught the special segment shapes (§7.5), a false claim about TypeScript enforcement was made
   true (§7.7), `X-Powered-By` was found on rather than off (§6.3), the traceability cells were found to assert
   the control absent and present at once (§9), and the counts below were wrong.

8. **Rebase onto a base that moved mid-ticket** — **DONE.** ACBP-P7-007 pushed `b958922` while this branch was
   being written, and it both touched four of this branch's files and added a gate this branch's CSV edits must
   pass (`tools/check-csv-shape.mjs` — run, green, 23 files). Rebased rather than pushed stale. One conflict, in
   the shared harness, resolved by taking the upstream file and re-applying the extraction on top — so P7-007's
   own fix to it (`HEAD` and `OPTIONS` added to `HTTP_METHODS`, without which a route exporting only those is
   discovered and silently skipped) moved **into** `route-inventory.ts` with the list rather than being dropped
   in the merge. The three CSV conflicts auto-merged; each row was re-parsed with a real CSV reader afterwards.

### §10.1 Mutation runs — LOCAL, and that word is load-bearing

Seven source edits, each removing or weakening one named control, each run against both suites — **34 tests**
(20 unit + 14 adversarial). This is what "the tests can fail" means here; a control nobody tried to break is
unmeasured by definition. Mutations 6 and 7 exist only because review found the defects they now pin.

| # | Mutation | Result |
|---|---|---|
| 1 | `proxy.ts` stops calling `applySecurityHeaders` | **4 red** — both sweeps, the 401 case, the coverage guard |
| 2 | `strict: true` → `false` (Clerk's default `script-src` returns, permitting `https: http: 'unsafe-inline'`) | **3 red** |
| 3 | `reportOnly: true` → `false` (the enforcing header would ship) | **6 red** |
| 4 | `x-frame-options` `DENY` → `ALLOWALL` (a value change, not a removal) | **5 red** |
| 5 | the `frame-ancestors 'none'` directive removed | **2 red** |
| 6 | `discoverPageFiles()` silently returns 2 of 3 pages | **1 red** — and **0 red** before §7.4 was rewritten |
| 7 | COOP re-added as `same-origin-allow-popups` | **5 red** |

Two further mutations were run outside the suites, because what they break is not a test:

- **renaming `reportOnly` → `reportingOnly` at the `clerkMiddleware` call site** → `tsc --noEmit` exits **2**
  with `TS2769 … Object literal may only specify known properties`; restored, exit **0**. That is §7.7's
  enforcement, demonstrated rather than asserted — and before the call site was written as an object literal
  the same rename typechecked **clean**.
- **`discoverPageFiles(...).slice(1)` against the OLD source guard** → all tests green, which is the finding
  that produced §7.4.

**These are LOCAL runs and carry no CI run id.** By the standard CDR-080 §1 sets for the twenty trust-critical
negatives, a mutation without a hosted run id is not a measurement. These suites need no database and no network,
so a hosted run will execute them with nothing skipped — but until that run exists on this branch's exact SHA,
the honest word for the figures above is **local**, and they are labelled that way rather than rounded up.

### §10.2 The hosted run this ticket still owes, and three VOID attempts at it

Run [`31120315913`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/31120315913) on
`9bc802d` reports `conclusion=failure` — **and it is void, not a regression.** The job-level facts, read from
the API rather than from the summary line:

```
job=verify  conclusion=cancelled  steps=0
annotation: "The job was not acquired by Runner of type hosted even after multiple attempts"
```

**Zero steps executed.** That is the signature `PROJECT-STATE.md` already documents for GitHub runner/startup
failures, where nothing in the workflow ran and there is therefore nothing in the result to respond to. Two
`gh run rerun --failed` attempts reproduced it identically. No code was changed in response, as that document's
outage instructions require.

**Verified against an independent anchor rather than assumed**, because "CI is flaky" is exactly the excuse a
real failure hides behind: run `31120570911` on the concurrent `p7-013-http-rate-limiting` branch has the
**same** `steps=0 / cancelled` shape, while that branch's earlier run `31119231280` reports `steps=14` and a
genuine `failure`. The void shape is therefore visible across branches and distinguishable from a real red —
and sibling runs `31120503219` and `31119574444` went green in the same window, so this is not an account-wide
block of the kind PROJECT-STATE records for 2026-07-28.

**A fourth attempt, and a better explanation than "runners were unavailable".** A *fresh* run on a new SHA —
`31123051670` on `135a883` — went void the same way, so the cause is not the rerun path. Meanwhile sibling run
`31120503219` reports `steps=14, success` in the same window: **runners were being acquired, just not for this
PR.** The distinguishing property is that **PR #80's base is `p7-007-security-test-pass`, a branch another
session is actively committing to**, while every PR that ran green targets `main`.

`pull_request` CI runs against `refs/pull/80/merge`, which GitHub recomputes on every push to the **base**.
`ci.yml` sets `concurrency: cancel-in-progress: true` keyed on `github.ref`, so a base push during a run
cancels it. The timeline fits: base commit `381601a` landed **17:35:30 UTC**, inside `31123051670`'s window
(created 17:24:55 UTC), and `gh pr view 80` still reports `mergeable=UNKNOWN, mergeStateStatus=UNKNOWN` —
GitHub has not settled the merge ref. The base has moved four times in roughly three hours.

**This is the stacking decision from the header note arriving as a concrete cost**, and it is an owner gate
rather than something to keep retrying. The options, none of which this ticket may take unilaterally:

1. **Wait for ACBP-P7-007 to merge**, then rebase this branch onto `main` and re-run. Cleanest; costs time.
2. **Re-target PR #80 at `main`.** Gets a stable base immediately, but the PR diff then contains all of
   P7-007's commits, which misrepresents what this ticket changed.
3. **Accept local verification**, as the owner explicitly did on 2026-07-29 during the CI outage
   (PROJECT-STATE). The local sweep here is real but is one machine and one PostgreSQL version, and the
   real-PostgreSQL suites are **skipped**, not green.

**Nothing here is measured until a run with `steps > 0` goes green on this branch's exact SHA.** §10.1's
figures stay labelled local, the trust-critical standard is unmet, and this is stated in the CDR rather than
left for a reader to infer from a red badge.
