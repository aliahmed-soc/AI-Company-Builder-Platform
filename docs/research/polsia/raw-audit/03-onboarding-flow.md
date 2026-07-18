# Onboarding flow

## Safe evidence

The current company’s activity stream visibly records a completed onboarding sequence:

`Getting started → Creating your company → Saving your brief → Dreaming up your idea → Researching your market → Drafting your company profile → Saving your profile → Setting up your email → Send company email → Saving your research → Writing your mission → Sketching your roadmap → Filing your documents → Locking in your vision → Announcing your launch → Provisioning your workspace → Setting up your codebase → Setting up your database → Warming up hosting → Spinning up a sandbox → Seed repo → Cloning your codebase → Designing your landing page → code reads/edits → npm → committing → publishing → cleanup/finalizing → planning first tasks → saving tasks → welcome email → Completed · onboarding`.

Evidence type: UI activity stream; confidence 99%. This proves the visible sequence for this test company, not private backend implementation.

## Creation choices

The current in-app FAQ states that clicking `+ New` offers:

- `Build my idea` — describe what to build.
- `Surprise me` — Polsia chooses based on the founder’s background.
- `Existing business` — connect and describe an existing business.

The FAQ says the minimum input is “just your idea” and that existing businesses can be described for immediate analysis. Evidence type: current first-party FAQ; confidence 85%.

## Safe stopping point

Clicking the visible `+ New` entry from the authenticated dashboard opened the `$25/month` subscription sheet rather than a free creation form. The sheet listed one company, 30 night shifts, five task credits (+10 first month), unlimited Strategy & Planning Chat, server/database/email/browser, and $5/month AI credits. The Subscribe action was not clicked, so a fresh disposable company was not created.

## Unknown or untested

- Exact question sequence, required/optional fields, adaptive follow-ups, skip behavior, assumptions, strategic alternatives, cost/risk/timeline previews, and pre-creation approval were not reachable without entering a paid flow.
- The activity stream shows “Researching,” “Drafting,” and “Provisioning” labels but does not establish which backend workers perform them.
- No charge, external account connection, publication, or deployment was initiated during the audit.
