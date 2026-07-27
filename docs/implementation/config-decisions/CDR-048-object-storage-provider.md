# CDR-048 — Object-storage provider and the storage adapter contract (ACBP-P0-005, NFR-014)

Status: **records an OWNER DECISION** taken 2026-07-27. Governs **ACBP-P0-005**. Governing ADR: **ADR-016**
(Accepted 2026-07-18 under the portability condition). Resolves open question **AOQ-03**.

## 1. The owner's decision, verbatim in substance

> Use S3-compatible object storage. One bucket per environment. Every object key/prefix scoped by `company_id` so
> cross-tenant access is structurally impossible, not just policy. No public bucket access — all reads via
> short-lived signed URLs.

## 2. It is consistent with ratified canon, and resolves what was left open

This is **not** a new architecture decision; it closes the one ADR-016 deliberately left open.

- ADR-016 already decided the *shape*: "S3-compatible object storage under `company/{company_id}/...` prefixes
  (invariant 19 pathing)", open formats, content-addressed keys, at-rest encryption. Its **Open questions** field is
  exactly `AOQ-03 (storage provider)`, and the owner review recorded provider selection as remaining open.
- The owner's decision therefore supplies: the provider *class* (S3-compatible — matching the portability condition
  the ADR was accepted under), the **bucket topology** (one per environment — new, ADR-016 did not state it), and an
  explicit **no-public-access** rule.
- ADR-016 already names the matching risk: *"signed-URL scope errors (prefix-scoped generation, tested)"*. This
  ticket is where "tested" becomes real.

**Scope note (honest):** the backlog row is Type **Decision**, size **S**, and its own deliverables are "Provider
chosen; S3 contract confirmed", the "storage adapter contract", and the subprocessor register entry. The document and
artifact *domain* — rows, versions, provenance — is **ACBP-P5-011**, and `DECISION-LOG.md` records that "P0-005
canonically gates P5-011 only". This ticket therefore builds the CONTRACT and its safety property, not the artifact
model.

## 3. Load-bearing reading — "structurally impossible" has to mean something specific

The owner asked for cross-tenant access to be **structurally impossible, not just policy**. A prefix convention that
callers are trusted to follow is policy. Three things make it structural:

- **G1 — the SAFE constructor is the only way to derive a tenant key.** `companyObjectKey(companyId, parts)` always
  emits `company/{companyId}/…`, and the branded `ObjectKey` type means a bare string will not type-check where a key
  is expected.
  **Corrected during the first review pass — G1 alone is NOT "structurally impossible", and this CDR originally
  overclaimed it.** ACBP-P0-019's pre-existing `toObjectKey(string): ObjectKey` is an *unchecked* cast, kept
  deliberately for platform-owned objects that have no tenant. It cannot be removed without breaking that case, so
  anyone can still mint a branded key from an arbitrary string. G1 is therefore a strong convention plus a
  type-level nudge — it stops accidents, not a determined caller. **G3 is the actual enforcement**, which is exactly
  why it exists and why the two are not redundant. Saying otherwise would have been the kind of security claim that
  reads as stronger than the code.
- **G2 — the derivation REJECTS anything that could escape the prefix**, rather than sanitising it quietly. Empty
  segments, `.`/`..`, leading or embedded slashes and backslashes, percent-encoded traversal (`%2e%2e`, `%2f`), NUL
  and control characters, and absolute-looking inputs are all refused as `invalid_segment`. Sanitising is the wrong
  behaviour here: silently rewriting `../other-company/secret` into something adjacent produces a key the caller did
  not ask for, and the caller is the one who knows whether that is acceptable.
- **G2b — the company id is CANONICALISED to lowercase before it becomes a prefix.** *Found in the second review
  pass.* The UUID check is case-insensitive and PostgreSQL renders `uuid` lowercase, so an id can legitimately reach
  the derivation in either case. Without normalisation, `AAAA…` and `aaaa…` — the same company — produce two
  **disjoint keyspaces**: objects written through one form are invisible *and* unverifiable through the other. It
  fails closed rather than leaking, but a company silently losing sight of its own documents because an id arrived
  from a different code path is not an acceptable failure either.
- **G3 — signing RE-VERIFIES ownership at issue time.** A key arriving from anywhere other than the current
  derivation — a database row, an export manifest, a retry payload — is checked against the requesting company's
  prefix before any URL is produced. G1 protects construction; G3 protects *use*, and the two failure modes are
  different: G1 stops a bug from minting a bad key, G3 stops a stale or tampered key from being honoured. Relying on
  G1 alone would mean any row that ever held a wrong key becomes a live cross-tenant read.

## 4. Reads

- **G4 — no public access, ever; reads are short-lived signed URLs.** The contract carries a bounded TTL with a
  platform maximum, clamped the same way the gateway clamps re-ask (a caller cannot request a long-lived URL). A URL
  is a bearer capability: the shorter it lives, the smaller the window in which a leaked link is a leaked document.
- **G5 — the TTL maximum is a platform constant, not a caller argument**, and is asserted by test. This mirrors
  `MAX_REASK_ATTEMPTS`: bounds that exist for safety are not configuration.

## 5. Bucket topology

- **G6 — one bucket per environment**, per the owner. Environment separation is at the *bucket* boundary and tenant
  separation is at the *prefix* boundary. They are deliberately different mechanisms: a misconfigured environment
  cannot see another environment's bucket at all, and within a bucket no tenant can address another tenant's prefix.
- **G7 — the bucket name is configuration, never derived from tenant data.** Deriving a bucket per company would
  make tenant isolation depend on a provider-side naming rule and would not scale within account limits; the prefix
  scheme is the isolation mechanism ADR-016 ratified.

## 6. What this ticket does NOT do, and why

- **No live provider call, and no vendor SDK dependency yet.** Exercising real S3 needs credentials and a real
  bucket, which is an owner gate of exactly the shape of P2-011 — and adding an SDK now would bind the port to one
  vendor before anything consumes it. The port is provider-neutral by construction and fully testable; the concrete
  adapter lands with **P5-011**, its first real consumer.
- **No migration.** Nothing is stored in Postgres by this ticket: artifact rows are P5-011's. Adding an unused table
  now would be speculative schema.
- **No new authz action, audit event, HTTP route or UI.**

## 7. Slice plan

1. CDR-048 + branch + draft PR.
2. The storage contract in `@acbp/contracts`: `companyObjectKey`, `verifyKeyBelongsToCompany`, the TTL clamp, and
   `SignedUrlIssuer`. Exhaustive escape tests (§3-G2).
   *Corrected during the first review pass:* this originally said "the provider-neutral `ObjectStoragePort`", and the
   first draft built one. **ACBP-P0-019 had already built the transport port** (`adapters/storage-provider.ts`), and
   its own header records that it deferred exactly two things until a provider was chosen — "no presigned-URL
   abstraction" and "this contract never derives cross-tenant keys". Those two *are* this ticket. A parallel port
   collided on export and, worse, would have meant two storage ports that could disagree about when a tenant
   boundary is crossed. The shipped work EXTENDS P0-019: same `ObjectKey` brand, transport port untouched, only the
   two deferred pieces added.
3. Docs: ADR-016 open question resolved, DATA-ARCHITECTURE, subprocessor register note, backlog Done.
4. TWO independent review passes + finalization.
