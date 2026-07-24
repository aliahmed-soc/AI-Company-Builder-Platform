# CDR-027 — Prompt/template registry v1 (ACBP-P2-004)

**Status:** Accepted (autonomous lead, standing Phase 2 authorization). **Requirements:** TASK-005 (provenance).
**Governing ADRs:** ADR-011 (gateway contract — `template_ref@version`), ADR-019 (initial model config — prompts
tested against both models; provider names only in gateway/config). **Architecture:** AI-AND-WORKER-ARCHITECTURE.md
§1 (component chain: *context assembly → prompt/template registry → model gateway*). **Depends on:** P2-003 (Done).

A **provider-neutral, versioned prompt/template registry**: the component that owns the versioned prompt templates
the gateway consumes by reference. The gateway (P2-003) already carries `template_ref@version` opaquely; this
ticket defines WHAT that ref resolves to, how versions are pinned, and how the version is stamped on derived
artifacts for attribution (TASK-005).

## 0. Storage decision — CONFIG, not a database table (no migration)

Templates are **global platform configuration**, not tenant data (backlog §Tenant considerations = "—";
§Rollback = "Versioned"). They follow the ADR-012 pattern — *"workers are versioned configuration + prompts over
one shared execution runtime"*. Therefore the registry ships as a **closed, code-defined `as const`-style registry
in `@acbp/contracts`** (mirroring the `AUDIT_EVENTS` closed registry), with **no migration, no RLS, no new
SECURITY DEFINER** (the allowlist stays exactly three), and **no tenant scoping**. Versioning is by explicit
integer version bumped in code; a change is a NEW version (never an in-place edit), so provenance stays
reproducible. This is the least-authority, most-reversible interpretation and keeps the trust-critical DB surface
untouched.

## 1. The template contract (`@acbp/contracts/model/template.ts`)

- **`TemplateDefinition`** = `{ family, version, taskClass, segments[], slots[] }`. `family` is a dot-namespaced
  capability/task-type (e.g., `interview.followups`); `version` a positive integer; `taskClass` binds the gateway
  timeout/fallback policy (`@acbp/contracts` `TaskClass`); `segments` are role-tagged provider-neutral text with
  `{{slot}}` placeholders; `slots` are the named inputs the caller must fill.
- **`templateRef(def)` → `family@version`** and **`resolveTemplateRef(ref)`**: parse + look up, **deny-by-default**
  — a malformed ref or an unregistered family/version throws a validation error (never a silent fallback to a
  different version). **`latestTemplate(family)` / `latestTemplateRef(family)`** pin the highest version.
- **`templateProvenance(def)` → `{ template_ref, template_version }`**: the bounded, provider-neutral attribution
  stamped on every derived artifact (TASK-005) and available alongside the gateway's `model@version` stamp.
- **`renderTemplateSegments(def, values)`**: substitutes the template's OWN declared `{{slot}}` placeholders —
  rejecting a missing value or an unknown key (no silent blanks, no leaked extras). Combining the rendered
  template with ranked memory context, the secret blocklist, and MEM-004 precedence is **CONTEXT ASSEMBLY's job
  (P2-007)** — out of scope here.
- **Self-consistency** is asserted at module load: unique `family@version`, valid family/version/slots, and
  declared slots ⇔ used placeholders. A malformed seed cannot ship.

## 2. "Version changes audited" (backlog §Audit) — interpretation

Templates are compile-time configuration, so "version changes" are **git-tracked and code-reviewed** (the audit of
config), and every USE stamps the immutable `template_ref@version` onto the derived artifact (provenance =
attribution trail). There is **no runtime template-mutation API** in v1, so **no new runtime audit event** and no
`AUDIT_EVENTS` addition are introduced — adding one would require a mutation path that does not (and should not)
exist. When a later ticket introduces artifacts, it records `templateProvenance(...)` alongside `model@version`.

## 3. Provider-neutrality (ADR-011 / ADR-019)

No provider name or dialect appears in any template (enforced by a neutrality test scanning all seed content).
Provider selection stays in the gateway adapters + configuration. Prompts are authored to be tested against both
configured model families (ADR-019) by later generation tickets.

## 4. Scope

- **Included:** the versioned registry + resolution (deny-unknown) + latest-version pinning + provenance +
  own-segment rendering + self-consistency; three minimal, provider-neutral v1 seed families
  (`interview.followups`, `extraction.fields`, `classification.intent`) spanning the generation/extraction/
  classification task classes; unit tests; this CDR + the architecture §1 status note.
- **Excluded / deferred:** any DB table or migration; final prompt WORDING and additional families (P2-005 interview
  orchestration, P2-007 assembly, P2-008 understanding refine/version-bump the content); context assembly, memory
  ranking, the secret blocklist, MEM-004 precedence (P2-007); artifact persistence + the actual stamping call
  site (later artifact-producing tickets consume `templateProvenance`); a runtime template-management/CRUD API;
  provider dialects.

## 5. Slice plan

1. **Contracts** (`@acbp/contracts/model/template.ts`) + unit tests + this CDR + architecture §1 note.
2. (If needed) a thin `@acbp/core` convenience seam + docs; independent reviews; finalization.
