# Source Classification Report — AI Company Builder Platform

**Version:** 1.0
**Date:** 2026-07-18
**Status:** Complete for the file set specified by the owner; ambiguous items flagged for owner review
**Purpose:** Establish which pre-existing documents may safely inform the AI Company Builder
Platform, and isolate this product from Halo Suite / Systevo material.

---

## 1. Existing files inspected (read-only; none modified)

All paths relative to `E:\Halo-Suite\halo-suite\` unless noted.

| # | Path | Inspected how |
|---|---|---|
| 1 | `docs/PRD.md` | Header + §TOC + identity-marker search (1,885 lines; full read not required for classification) |
| 2 | `docs/requirements.md` | Full read |
| 3 | `README.md` (repo root) | Full read |
| 4 | `docs/README.md` | Full read |
| 5 | `docs/deploy-hostinger-vps.md` | Full read (compressed) |
| 6 | `docs/vps-access.md` | Structure only (headers + credential-field count) — deliberately not read in full to avoid handling secrets |
| 7 | `scripts/` | Directory listing (6 files) |
| 8 | `.cursor/rules/model-routing.mdc` | Full read (authored this session) |
| 9 | `E:\Halo-Suite\tooling\cursor-rules\model-routing.mdc` | Hash comparison vs #8 |

## 2. Classification of each file

### 2.1 `docs/PRD.md` — **Halo Suite only**
- **Evidence:** Title "Halo Suite — Product Requirements Document"; Document ID `PRD-HALO-SUITE-001`; brand "Halo Suite — Scale Smarter, Not Harder"; Base44 parity rebuild scope; 0 mentions of Polsia/ACBP; describes CRM/marketing/construction-PM product.
- **Why:** Every requirement, entity, and FP-* item is Halo-Suite-specific.
- **Import:** **NO.** Sanitization: n/a. Cross-reuse risk: **HIGH** — it is a full PRD for a *different* AI-native platform; superficially similar vocabulary ("AI-native", "Guardian AI") makes accidental requirement bleed-through the single largest contamination hazard.

### 2.2 `docs/requirements.md` — **Halo Suite only** (with generic fragments)
- **Evidence:** "Halo Suite — Project Requirements"; halo-specific services (`halo-uploads` bucket, `dev@halo.local` seed login), Halo env vars, Halo deploy topology.
- **Why:** An infra checklist for the Halo stack, not the new product.
- **Import:** **NO.** Generic fragments (e.g., "generate JWT secrets with openssl") are common knowledge, not worth importing. Cross-reuse risk: MEDIUM — importing it would smuggle in stack decisions (NestJS/Next/BullMQ) the new product has not made.

### 2.3 `README.md` (root) — **Halo Suite only**
- **Evidence:** "Halo Suite — AI-native business growth platform — independent rebuild from the Base44 prototype"; milestone table M1.1–M3.6.
- **Import:** **NO.** Cross-reuse risk: LOW (obviously branded).

### 2.4 `docs/README.md` — **Halo Suite only**
- **Evidence:** "Halo Suite planning and parity documents"; Base44 parity policy; ADR index.
- **Import:** **NO.** Cross-reuse risk: LOW.

### 2.5 `docs/deploy-hostinger-vps.md` — **Mixed: Halo Suite + Sensitive operational material**
- **Evidence:** Halo-branded deploy guide containing real infrastructure identifiers: hostname `srv1812096.hstgr.cloud`, IPv4 `31.220.104.240`, private-repo URL, GitHub collaborator username, TLS contact email, applied hardening state.
- **Why:** Operational runbook bound to a specific live server and to Halo Suite's compose files.
- **Import:** **NO.** Would require heavy sanitization even as a generic template; not worth it. Cross-reuse risk: MEDIUM — and **operational risk** if the new repo is ever shared, since it exposes a live server's identity and configuration posture.

### 2.6 `docs/vps-access.md` — **Sensitive operational material** (Halo Suite only)
- **Evidence:** 76 lines titled "VPS access & recovery (Hostinger)"; sections for SSH, recovery, deploy keys, automation access; 25 credential-adjacent field matches. Contents deliberately not read in full and not reproduced anywhere.
- **Import:** **NO — EXCLUDED as sensitive.** Must never enter the new repository. Cross-reuse risk: n/a; **exposure risk: HIGH.**

### 2.7 `scripts/` — **Halo Suite only**
- **Evidence:** `ai-smoke.mjs`, `dev-stack.mjs`, `generate-prd-appendix.mjs`, `prd-audit.mjs` (operate on the Halo PRD/stack), `vps-bootstrap.sh`, `vps-harden.sh` (target the Halo VPS).
- **Import:** **NO.** Cross-reuse risk: LOW–MEDIUM (the harden/bootstrap patterns are generic, but fresh scripts should be written when the new product actually deploys).

### 2.8 `.cursor/rules/model-routing.mdc` + tooling copy — **Generic reusable engineering guidance** (authored for ACBP)
- **Evidence:** The operating protocol written this session; §0 already declares ACBP identity and Halo/Systevo exclusion; verified byte-identical pair (SHA256 `613F4096…`).
- **Import:** **YES — imported** (the only approved import from the Halo workspace). Sanitization performed: §0 identity wording updated to name this repository as the standalone home. Cross-reuse risk: NONE — it is the anti-contamination control itself.

## 3. Files approved for import
| File | Destination | Note |
|---|---|---|
| `model-routing.mdc` (protocol) | `.cursor/rules/` + `tooling/cursor-rules/` | Byte-identical pair verified |
| `polsia-audit.zip` (extracted) | `docs/research/polsia/raw-audit/` | 64 files; research evidence only |
| `polsia-audit-review.md` | `docs/research/polsia/` | Corrected build direction; hash-verified copy |

## 4. Files rejected from import
`docs/PRD.md`, `docs/requirements.md`, `README.md`, `docs/README.md`,
`docs/deploy-hostinger-vps.md`, `scripts/*` — all Halo Suite product/operational material
(reasons in §2). Also rejected pending owner review: `polsia-audit-complete.zip`,
`polsia-export-checked.zip`, `polsia-export-checked-source.zip` (see §6).

## 5. Sensitive files excluded
- `docs/vps-access.md` — live-server access/recovery document. Excluded outright; never read in full, never copied, no contents reproduced in this repository.
- `docs/deploy-hostinger-vps.md` — contains live server hostname/IP and account identifiers; excluded.

## 6. Ambiguous files needing owner review
| File (in `C:\Users\ali_n\Downloads\`) | Question |
|---|---|
| `polsia-audit-complete.zip` (386 KB, older than `polsia-audit.zip`) | Superseded draft or additional material? Import only if the owner confirms provenance and value. |
| `polsia-export-checked.zip`, `polsia-export-checked-source.zip` | Appear to be exported application code from the Polsia test run. Licensing/provenance unclear; **do not** treat exported third-party-generated code as a design source without an explicit owner decision. |
| `E:\Halo-Suite-V1\` directory | Contains byte-identical Polsia copies plus unknown other material; owner should state whether anything else there belongs to ACBP. |
| `E:\Halo-Suite\` share-root files (`ED3N/`, `defi-yield-landing.html`, Cursor chat exports, installers) | Presumed unrelated to ACBP; not inspected in depth; confirm none are ACBP source material. |

## 7. Polsia research files located
| File | Location(s) | SHA256 (first 16) | Disposition |
|---|---|---|---|
| `polsia-audit.zip` | Downloads + `E:\Halo-Suite-V1\` (byte-identical) | `D916D3A4E852F6AD` | Imported (extracted to `raw-audit/`) |
| `polsia-audit-review.md` | Downloads + `E:\Halo-Suite-V1\` (byte-identical) | `CB7D7DB04E548462` | Imported |
| Extraction screen | — | — | 68 entries; no cookies/auth-state/credentials/keys; screenshots pre-redacted |

## 8. Evidence available for the future Master PRD
From `raw-audit/` (25 documents + 14 mermaid diagrams + 15 evidence CSVs + 6 redacted screenshots):
executive summary, application map, onboarding flow, task/agent system, approval matrix,
integrations, billing/pricing, technical observations, claim verification, two PRD drafts,
requirements traceability CSV, MVP/roadmap, technical architecture, conceptual data model,
API/events, acceptance tests, risk register, competitive gaps, open questions,
frontend/backend requirements, exported-code verification, quality findings, runtime billing
validation, staging verification plan — plus `polsia-audit-review.md` with per-area confidence
ratings (80–96%) and the four-evidence-class caveat. **All of it is research input, not
approved specification.**

## 9. Risks of cross-project contamination
1. **Halo PRD bleed-through (highest):** both products are "AI-native platforms" with agents/AI copilots; requirement language could be copied across by habit. Mitigation: §0 scope-protection rule + this report + Halo docs never imported.
2. **Stack assumption inheritance:** Halo's NestJS/Next/Prisma/BullMQ choices must not become ACBP defaults without an explicit architecture decision. Mitigation: no app scaffold exists here; architecture decided only in approved docs under `docs/architecture/`.
3. **Evidence-class confusion inside Polsia research:** test-company ("Vigilix") output mistaken for platform capability. Mitigation: SOURCE-NOTES warning + review doc's classification.
4. **Path-name confusion:** the old workspace is named `E:\Halo-Suite`; directory names are historical artifacts, not product identity.
5. **Stale global agent config:** `~/.claude/CLAUDE.md` still describes an unrelated "Momentum Gym" project; agents must ignore it for ACBP work.

## 10. Recommended source-of-truth hierarchy (this repository)
1. User's latest explicit instruction
2. Approved Master PRD (`product-specification/MASTER-PRD-v1.md`, once approved)
3. Approved technical architecture
4. Approved requirement and acceptance-test documents
5. Approved decision records (`docs/decisions/`)
6. Verified research evidence (`docs/research/polsia/` — verified items only)
7. Current implementation and tests (none yet)
8. Raw research and historical materials (`raw-audit/`)
9. Assumptions

**Standing rule:** raw Halo Suite product documents must never become a source for
AI Company Builder Platform requirements unless explicitly imported by the owner.
