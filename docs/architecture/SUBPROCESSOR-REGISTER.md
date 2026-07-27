# Subprocessor register

Required by **ADR-005** ("subprocessors must be recorded"; "data-location + subprocessor register maintained from the
first deployed environment"), and feeds NFR-011's data map. Created by **ACBP-P0-005**, whose row names
"Provider enters subprocessor register" as a security consideration.

**This register is not yet complete, and says so.** A subprocessor is a named legal entity that processes customer
data. Where a decision has selected a *protocol class* rather than a *vendor*, the row records that honestly instead
of inventing a name — an entry naming a company nobody has contracted with would be worse than a gap, because it
reads as due diligence that did not happen.

ADR-005 also binds: customers must **never** be told their information remains in a specific country unless the
system actually guarantees it. Nothing in this register may be used as the basis for a residency claim until the
Location column names a real, contracted region.

| Purpose | Subprocessor | Data processed | Location | Status |
| --- | --- | --- | --- | --- |
| Model inference (primary) | *Not yet contracted* | Prompt context assembled per call; no raw credentials | Unknown | **Pending ACBP-P2-011** — needs a paid account (owner gate) |
| Object storage — artifact/document content | *Vendor not yet named* | Generated artifact and document content, under `company/{company_id}/` prefixes | Unknown | **Class decided, vendor pending** — see below |
| Application hosting + managed Postgres | *Not yet contracted* | All tenant data at rest | Unknown | **Pending ACBP-P7-006** — needs a live environment (owner gate) |

## Object storage — what has and has not been decided

The owner's decision of **2026-07-27** (CDR-048) selected **S3-compatible object storage**, one bucket per
environment, `company_id`-scoped keys, no public access, reads via short-lived signed URLs.

- **Decided:** the protocol class, the topology, and the isolation and access rules. ADR-016's portability condition
  is satisfied, and AOQ-03 is resolved to the extent that the *contract* is now fixed.
- **Not yet decided:** which company operates the bucket. "S3-compatible" is a protocol, not a subprocessor — AWS
  S3, Cloudflare R2, Backblaze B2, MinIO on own hardware and several others all satisfy it, and they are different
  legal entities in different jurisdictions with different data-processing terms.

**Consequence:** this row cannot be completed, and no residency statement can be made about artifact content, until a
vendor is named. That naming does not block any engineering work — the platform contract is provider-neutral by
construction and the concrete adapter (ACBP-P5-011) can be written against any S3-compatible endpoint — but it does
block customer-facing residency copy and any DPA.

## Maintenance

Every new external data processor is added here **in the same change that introduces it**, not afterwards. A
processor reaching production without a row is a defect, not an oversight to tidy up later.
