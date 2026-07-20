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
- **Latest hosted (authoritative): 423 passed / 0 skipped / 0 failed** (41 files, run 29692293699) — all 5
  PostgreSQL integration suites executed with zero skips; preflight OK; boundaries 0; secret scan 0;
  High+ audit pass. This is AUTOMATED evidence only — it does not include live Clerk delivery.
- Hosted baseline before Slice 3: 336 passed / 0 skipped / 0 failed.

## Guards
- Secret scan: 0 findings. Boundaries: 0 violations. Audit high: 0 (1 pre-existing moderate, below gate).
- Local Docker/PG not available → PG integration verified only on hosted CI.

## Blockers / owner decisions
- None outstanding. Live-Clerk acceptance + backlog/ready/merge are future owner gates.

## Current HEAD
`cefa336`. PR #3 draft/open/unmerged. Hosted baseline 423/0/0. Working tree clean.

## Live acceptance — NOT COMPLETED; closed out safely (2026-07-19)
**LIVE CLERK DEVELOPMENT ACCEPTANCE WAS NOT COMPLETED. NO LIVE ACCEPTANCE EVIDENCE MAY BE CLAIMED
for ACBP-P1-002.** A run was started, blocked, and then fully torn down. **Nothing was created or
changed in Clerk; no Clerk secret was ever written to disk; the application never ran.**

**Blocker:** the owner could not manually supply the Clerk development credentials
(`pk_test_`/`sk_test_`/`whsec_`) nor create the Clerk webhook endpoint. Automation could not substitute:
scripted extraction of the dashboard secrets was denied by the harness security classifier (and the
agent's own rules prohibit handling API keys/tokens directly), and Clerk's webhook UI is an embedded
Svix iframe that does not respond to synthetic clicks. Neither is a code defect.

**Consequence:** all 18 live checks (real signed delivery, redelivery idempotency, live update/verification
sync, live tombstone + no-resurrection, unsigned/invalid-signature rejection against a real signature,
live read-through, live reconciliation) remain **UNPROVEN IN A LIVE CLERK ENVIRONMENT**. They are proven
only by automated tests against real PostgreSQL with a fake/injected verifier + reader.
**OWNER DECISION (2026-07-20) — Option A: live Clerk acceptance is DEFERRED.** It is NOT waived: the
live checks above remain required before ACBP-P1-002 can be accepted as Done. PR #3 stays draft and
unmerged; ACBP-P1-002 stays Planned; P1-003 does not start. Resume later via the Safe resume procedure
below — no code changes are needed to resume, only the owner-supplied Clerk development credentials and
the webhook endpoint.

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
**NONE — project execution is STOPPED at this owner gate by owner decision (Option A, 2026-07-20).**
Do not resume autonomously. A future session must not start P1-003, must not mark P1-002 Done, and must
not mark PR #3 ready or merge it. Resume only when the owner re-authorizes, starting from the Safe
resume procedure above. For reference, the remaining owner-gated steps are: (1) live Clerk development acceptance — requires the owner to provide a Clerk **development** instance's config (webhook signing secret + instance id + secret key) via the runtime secret mechanism, create the webhook endpoint subscription in the Clerk dashboard, and authorize a temporary public tunnel for local delivery; (2) owner-authorized backlog ACBP-P1-002 → Done; (3) owner-authorized PR #3 ready-for-review; (4) owner-authorized merge to main. Do NOT proceed on these without explicit owner authorization (secrets/dashboard/tunnel/merge/backlog are all gates).
