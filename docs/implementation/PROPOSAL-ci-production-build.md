# Proposal — add a production build step to CI

**Status:** PROPOSAL ONLY. Not scheduled, not started. Owner decides whether this becomes a ticket.
**Raised:** 2026-08-14, during ACBP-API-003.

---

## The gap

**CI never produces the production build artifact.** The `verify` job runs typecheck, lint, tests,
boundaries, secrets, encoding, CSRF-origin-gate, rate-limit-coverage and dependency advisories. It does not
run `next build`.

So `apps/web` is the one deliverable the pipeline never constructs. Every guard the repo has can be green
against a web app that does not build.

## How it surfaced, and the honest version of that story

I reported a broken build on `main` and **was wrong** — I had run `pnpm exec next build`, bypassing the
project's script and its `--webpack` flag, so Next 16 defaulted to Turbopack, which `next.config.ts:31`
documents the repo as deliberately pinning away from. I then "confirmed" it by repeating the same wrong
command on a clean checkout. Running the wrong command twice is not corroboration. `pnpm run build`
succeeds on both `main` and the branch; the finding was retracted in full.

**The gap is real anyway, and is not evidence of a current defect.** What the episode actually showed is
that nobody — human or agent — could answer "does the app build?" from CI evidence. It had to be run by
hand, and the first hand-run was done wrong. A pipeline step would have made the question answerable in
one place, correctly, by construction.

## What it would catch

A class no existing gate can see, because every current gate stops at the type or unit level:

- **bundler resolution failures** — the barrel/`extensionAlias` arrangement `next.config.ts` exists to
  solve is exactly the kind of thing that breaks silently on a dependency bump;
- **config drift on framework upgrades** — the Turbopack-vs-webpack default change is a live example: the
  repo is one flag away from a build that fails, and only the script protects it;
- **static generation errors** — routes that typecheck but throw at prerender;
- **transitive runtime breakage from an override** — e.g. the nanoid override is CARET-pinned precisely
  because nanoid 4+ is ESM-only and postcss needs CJS. That constraint is enforced today only by a comment
  and by whoever remembers to build locally. Twice now that override has been bumped under audit pressure.

## Cost

- **Wall clock:** the local build completes in well under a minute on this repo (3 static pages). Expect
  1–3 minutes in CI including install reuse — small next to the existing test job.
- **Maintenance:** near zero. One step, one command, no new tooling. It uses the project's own script, so
  it cannot drift from how the app is really built — which is precisely the failure this proposal is about.
- **Flake risk:** low, but real. A build step is a new thing that can go red for environmental reasons, and
  this repo has already seen an advisory gate redden clean branches twice. It should be treated the same
  way: a red there needs diagnosis before anyone assumes the branch broke.

## Where it sits in the gate

**After typecheck and lint, before or beside the test job.** Rationale: a build failure is usually cheaper
to read than a test failure, and a repo that cannot build has a more fundamental problem than a failing
assertion. It must invoke `pnpm run build` — NOT `next build` — so the `--webpack` pin travels with it.

**It should NOT block on the same conditions as `pnpm audit`.** The advisory gate reports the state of the
world; a build failure reports the state of the diff. Conflating them would repeat the confusion that
produced my false finding.

## What this proposal deliberately does NOT claim

- It does not claim the build is currently broken. **It is not.**
- It does not claim any shipped ticket was affected. Eleven HTTP routes shipped across API-001/002/003
  against a working build; an earlier statement of mine to the contrary was wrong and is retracted.
- It does not propose deploying anything. Building is not shipping, and a deploy step is a separate
  decision with its own owner gate.
