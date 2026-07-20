# PROJECT-STATE.md — factual state (autonomous lead)

_Read this first on resume, then continue automatically to "Next executable action". No secrets/PII here._

## Active
- Ticket: **ACBP-P1-002** — Internal user mapping with replay-safe webhooks (status: **Planned**; owner-gated to move to Done).
- Branch: `p1-002-user-mapping-webhooks`
- PR: **#3** (draft, open, unmerged, base `main`) — https://github.com/aliahmed-soc/AI-Company-Builder-Platform/pull/3
- Base main: `a2603b62e60996a3f920154a13807f834552d77b`

## Slices
- Slice 1 (schema/migration/neutral contracts/config) — committed, hosted-green.
- Slice 2 (verifier + processor + repos, replay-safe) — committed, hosted-green (`5fe3c00`), fixture fix `8c8dd76`.
- Slice 3 (webhook route + read-through) — committed `7a2e9ac` + fix `eb6be76`, hosted-green (409/0/0).
- Nightly drift reconciliation (worker command) — committed `b8dff96`, **hosted-green** (run 29692293699; 423 passed / 0 skipped / 0 failed).
- **ALL CODE-ONLY P1-002 WORK COMPLETE + HOSTED-GREEN.**
- Owner-gated tail (BLOCKING, not started): live Clerk dev acceptance (needs credentials/dashboard/tunnel), final owner-authorized backlog→Done, PR ready-for-review, merge.

## Test baselines
- Hosted baseline before Slice 3: 336 passed / 0 skipped / 0 failed. PG integration: database 10, user-mapping 15, webhook-processing 20.
- Local after Slice 3 (PG suites skip without `ACBP_TEST_DATABASE_URL`): 351 passed / 56 skipped / 0 failed; +60 new unit/route tests; new PG suite `read-through.integration.test.ts` = 11 (skipped locally).

## Guards
- Secret scan: 0 findings. Boundaries: 0 violations. Audit high: 0 (1 pre-existing moderate, below gate).
- Local Docker/PG not available → PG integration verified only on hosted CI.

## Blockers / owner decisions
- None outstanding. Live-Clerk acceptance + backlog/ready/merge are future owner gates.

## Current HEAD
`cefa336`. PR #3 draft/open/unmerged. Hosted baseline 423/0/0. Working tree clean.

## Live acceptance attempt — HALTED SAFELY (2026-07-19)
A live Clerk DEVELOPMENT acceptance run was started and then safely torn down. **Nothing was created
or changed in Clerk; no secret was ever written to disk; no application ever ran.**

Two hard blockers stopped it (both need an owner action, neither is a code defect):
1. **Clerk secrets cannot be retrieved by automation.** Scripted extraction of the publishable/secret/
   signing values from the dashboard was denied by the harness security classifier, and the agent's own
   rules prohibit handling API keys/tokens directly. → The owner must paste the values into `.env.local`.
2. **Clerk's webhook UI is an embedded Svix iframe.** It does not respond to synthetic CDP clicks
   (`+ Add Endpoint` produced no dialog across repeated attempts). → The owner must create the endpoint.

Verified end state: cloudflared terminated (0 processes; edge returns 502 = no connector); Next.js never
started (port 3000 never listened); temp listener/logs/scripts deleted; all `CLERK_*` and
`NEXT_PUBLIC_CLERK_*` vars stripped from `.env.local` (only `APP_ENV`, `DATABASE_SSL`, `DATABASE_URL`,
`ACBP_TEST_DATABASE_URL` remain); Clerk dashboard shows **0 webhook endpoints** and **0 users**;
`.env.local` ignored + untracked; secret scan 0 findings; working tree clean.

Local infra that survives and can be reused: WSL distro `acbp-local-dev` PG16 running
(`db.ps1 -Action start` is required after a reboot to activate Windows→WSL localhost forwarding);
`acbp_dev` already migrated through `0002`.

## Safe resume procedure (live acceptance)
1. `powershell -File tools/local/db.ps1 -Action start` → confirm `127.0.0.1:5432` reachable from Windows.
2. Start a tunnel: `cloudflared tunnel --url http://localhost:3000` → capture the `https://….trycloudflare.com` origin.
3. OWNER: in the Clerk **Development** dashboard → Configure → Webhooks → **+ Add Endpoint**, URL
   `<tunnel-origin>/api/webhooks/clerk`, subscribe ONLY `user.created`, `user.updated`, `user.deleted`.
4. OWNER: append to `E:\AI-Company-Builder-Platform\.env.local` (git-ignored; never paste in chat):
   `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_…`, `CLERK_SECRET_KEY=sk_test_…`,
   `CLERK_WEBHOOK_SIGNING_SECRET=whsec_…`, `CLERK_WEBHOOK_INSTANCE_ID=ins_…`
   (instance id is non-secret and readable from the dashboard URL).
5. Agent resumes: `pnpm --filter @acbp/web dev`, verify the tunnel reaches the route, then run the 18
   live acceptance checks, then the full cleanup + gate + hosted CI + final audit.

## Next executable action
STOPPED AT OWNER GATE (live acceptance halted — see above; resume via the Safe resume procedure).
All code-only P1-002 work is hosted-green. The remaining steps are all owner-gated: (1) live Clerk development acceptance — requires the owner to provide a Clerk **development** instance's config (webhook signing secret + instance id + secret key) via the runtime secret mechanism, create the webhook endpoint subscription in the Clerk dashboard, and authorize a temporary public tunnel for local delivery; (2) owner-authorized backlog ACBP-P1-002 → Done; (3) owner-authorized PR #3 ready-for-review; (4) owner-authorized merge to main. Do NOT proceed on these without explicit owner authorization (secrets/dashboard/tunnel/merge/backlog are all gates).
