// @acbp/core — export of a company's owned data (ACBP-P7-001; CDR-078; EXPORT-001, NFR-014; ADR-002, ADR-016;
// trust-critical #2; invariant 19).
//
// ── THE SHAPE, AND WHY IT IS THIS SHAPE ──────────────────────────────────────────────────────────────────────
//
// Resolve the company scope (owner-only `export:create`) → for every DECLARED collection: read it bounded, verify
// each row's ownership, sanitize every value, write the JSON, READ IT BACK → build the manifest from what was
// actually emitted → write the manifest → audit, LAST.
//
// ADR-002 makes this the ownership guarantee, and it fails in two directions that pull against each other
// (CDR-078 §0): under-delivering silently, and over-delivering irreversibly. Almost every decision below is about
// which of those a given branch must risk, and the answer is always the same — an omission is a complaint the
// founder can act on, a leaked secret is gone.
//
// NOT PRODUCTION-COMPLETE ON MERGE, and deliberately not claimed to be: there is no S3-compatible adapter and no
// dependency for one (CDR-078 §1). Everything asserted here — ownership verification, manifest correctness,
// secret exclusion, cross-tenant denial, partial enumeration — is provable against the in-memory adapter, because
// none of those properties are about S3. That an archive lands DURABLY is not provable and is claimed nowhere.
import { createHash } from 'node:crypto';
import { ExportRepository, writeAuditEvent, type DatabaseClient, type AuditScope, type AuditWriteContext } from '@acbp/database';
import {
  EXPORT_COLLECTIONS,
  buildExportManifest,
  manifestIsFaithful,
  sanitizeExportValue,
  partitionRowsByOwnership,
  exportRowIdentity,
  WITHHELD_IDENTITY,
  companyObjectKey,
  keyString,
  verifyPersistedObject,
  generateEventId,
  artifactExported,
  type AuditEvent,
  type ExportManifest,
  type ExportManifestItem,
  type ExportOmission,
  type ObjectKey,
  type ObjectStorage,
} from '@acbp/contracts';
import type { Logger } from '@acbp/observability';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';

type AuditWriteFn = (scope: AuditScope, event: AuditEvent, ctx?: AuditWriteContext) => Promise<string>;

/**
 * Rows read from any one collection before the archive reports the rest as `truncated`.
 *
 * Every other read in this codebase is bounded and an unbounded export read is a real memory hazard, but a bound
 * that silently drops rows converts the ownership guarantee into exactly the lie CDR-078 §0 is about. So the read
 * asks for `cap + 1` and the extra row becomes an enumerated omission — honest in both directions.
 */
export const MAX_EXPORT_ROWS_PER_COLLECTION = 5000;

export interface ExportCompanyDataParams {
  readonly userId: string;
  /** A REQUEST. The archive is stamped from the RESOLVED scope, never from this (CDR-078 §6-G5; invariant 19). */
  readonly accountId: string;
  /** A REQUEST, same as above. */
  readonly companyId: string;
}

export interface ExportCompanyDataOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  /** Injected clock. The manifest's `generatedAt` and the archive id both derive from it. */
  readonly now?: Date;
  /** Per-collection row bound (default {@link MAX_EXPORT_ROWS_PER_COLLECTION}); clamped into range. */
  readonly maxRowsPerCollection?: number;
  /** TEST SEAM ONLY: override the in-tx audit writer to force a failure. */
  readonly auditWriter?: AuditWriteFn;
}

export type ExportCompanyDataResult =
  | {
      readonly status: 'ok';
      /** Identifies the archive AND is its storage prefix. There is no export job row (CDR-078 §6.7). */
      readonly exportId: string;
      readonly manifest: ExportManifest;
      /** Key of the manifest object within the archive. */
      readonly manifestKey: string;
    }
  | { readonly status: 'forbidden' };

function clampCap(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MAX_EXPORT_ROWS_PER_COLLECTION;
  const n = Math.floor(value);
  if (n < 1) return 1;
  if (n > MAX_EXPORT_ROWS_PER_COLLECTION) return MAX_EXPORT_ROWS_PER_COLLECTION;
  return n;
}

/** Two spaces, so an archive a founder opens in a text editor is readable (NFR-014's spirit, not just its letter). */
function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Write one object and PROVE IT LANDED before anything records that it exists.
 *
 * TASK-005's quiet failure half, reused rather than re-derived: a `put` that returns success for bytes that never
 * landed leaves a manifest describing files that are not there — a document that agrees with itself and disagrees
 * with reality, which is the exact CDR-073 §0 shape the manifest exists to prevent.
 *
 * THROWS rather than omitting. A dropped write is not a partial-data condition; the archive is broken, and
 * throwing here means the audit event is never written, so nothing claims an export that did not happen (CDR-078
 * §6.6). ENFORCED BY: "refuses the whole export when storage reports success for bytes that never landed".
 */
async function putVerified(storage: ObjectStorage, key: ObjectKey, bytes: Uint8Array): Promise<void> {
  await storage.put({ key, body: bytes, contentType: 'application/json', checksum: { algorithm: 'sha256', value: sha256(bytes) } });
  const verification = verifyPersistedObject(await storage.head(key), bytes.byteLength);
  if (!verification.ok) {
    throw new Error(`Export aborted: object did not land (${verification.reason}).`);
  }
}

/**
 * Produce an archive of everything the company owns, plus the manifest that says what is in it and what is not.
 *
 * Owner-only, company-scoped, dual-keyed RLS. Returns `forbidden` for a viewer or a non-member without saying
 * whether the company exists (CDR-078 §3-G8).
 *
 * `storage` is a REQUIRED positional parameter, not an option. CDR-075 §4.3 had to disclose a ceiling that no
 * production path enforced because its seam was optional and defaulted to permissive; an export that silently
 * wrote nowhere would be the same failure with worse consequences.
 */
export async function exportCompanyData(
  client: DatabaseClient,
  storage: ObjectStorage,
  params: ExportCompanyDataParams,
  options: ExportCompanyDataOptions = {},
): Promise<ExportCompanyDataResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const cap = clampCap(options.maxRowsPerCollection);
  const now = options.now ?? new Date();
  const optsBase = {
    ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };
  const auditCtx: AuditWriteContext = options.correlationId !== undefined ? { correlationId: options.correlationId } : {};

  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<ExportCompanyDataResult> => {
      if (checkAuthorization(role, 'export:create', { accountId: params.accountId, actorId: params.userId }, optsBase).kind === 'deny') {
        return { status: 'forbidden' };
      }

      // INVARIANT 19. Everything below is stamped from the RESOLVED scope, never from `params`. The two are equal
      // only by coincidence of the current call path — the same reasoning `enqueueJob` uses — and an archive
      // labelled from a request rather than from what was verified is a document whose ownership claim is the
      // caller's assertion. ENFORCED BY: "stamps the manifest from the resolved scope, not the request".
      const accountId = scope.tenant.accountId;
      const companyId = scope.tenant.companyId;

      const exportId = generateEventId(now.getTime());
      const objectKey = (filename: string) => {
        const derived = companyObjectKey(companyId, ['exports', exportId, filename]);
        // A refusal here means the scope's company id is not a UUID, which would make EVERY key wrong. Failing the
        // whole export is right: there is no partial archive to salvage, only a wrong prefix to write under.
        if (!derived.ok) throw new Error(`Export aborted: could not derive a company-scoped key (${derived.reason}).`);
        return derived.value;
      };

      const repo = new ExportRepository(scope.db);
      const items: ExportManifestItem[] = [];
      const omissions: ExportOmission[] = [];

      for (const collection of EXPORT_COLLECTIONS) {
        // `cap + 1`: the extra row is how truncation is DETECTED rather than silently applied (CDR-078 §6-G7).
        const rows = await repo.readCollection(collection.table, cap + 1);
        const truncated = rows.length > cap;
        const kept = truncated ? rows.slice(0, cap) : rows;
        if (truncated) {
          omissions.push({ itemType: collection.table, itemId: collection.table, reason: 'truncated' });
        }

        // Ownership re-verified beneath RLS (CDR-078 §6-G6). Unreachable while RLS holds; this is the layer that
        // still refuses if it ever does not.
        //
        // THE FOREIGN ROW'S IDENTITY IS WITHHELD, and that is not fastidiousness. This manifest is a document the
        // FOUNDER reads: writing another tenant's row id into it would confirm that another tenant's record exists
        // and name it, which is precisely what §3-G8 forbids a refusal from doing. They still learn everything
        // actionable — which collection, and how many rows — because each withheld row is its own enumerated
        // omission. `partitionRowsByOwnership` does not return the identities at all, so this cannot regress by
        // someone deciding the manifest would be "more helpful" with them.
        const { owned, foreignCount } = partitionRowsByOwnership(collection.table, kept, companyId);
        for (let i = 0; i < foreignCount; i += 1) {
          omissions.push({ itemType: collection.table, itemId: WITHHELD_IDENTITY, reason: 'ownership_unverified' });
        }

        const emitted: unknown[] = [];
        let redactionCount = 0;
        for (const row of owned) {
          const sanitized = sanitizeExportValue(row);
          if (sanitized.status === 'excluded') {
            omissions.push({ itemType: collection.table, itemId: exportRowIdentity(collection.table, row), reason: sanitized.reason });
            continue;
          }
          emitted.push(sanitized.value);
          redactionCount += sanitized.redactionCount;
        }

        // The collection file carries its own NOTE, so an archive read years later explains what each file is
        // without needing this repository.
        const bytes = encodeJson({ collection: collection.table, note: collection.note, rowCount: emitted.length, rows: emitted });
        const key = objectKey(`${collection.table}.json`);
        await putVerified(storage, key, bytes);
        items.push({ itemType: 'collection', itemId: collection.table, path: keyString(key), sha256: sha256(bytes), rowCount: emitted.length, redactionCount });
      }

      const manifest = buildExportManifest({ accountId, companyId, generatedAt: now.toISOString(), items, omissions });
      const manifestBytes = encodeJson(manifest);
      const manifestKey = objectKey('manifest.json');
      await putVerified(storage, manifestKey, manifestBytes);

      // AUDIT LAST (CDR-078 §6.6). Audit-then-write would leave, on a storage failure, a permanent record
      // asserting an export that does not exist — a trail that lies, which is worse than no trail. This ordering
      // leaves the opposite residue on an audit failure: objects with no record, which are inert (the prefix
      // carries a per-run id, nothing lists it, and no surface can hand out a link to an archive with no audit
      // row) and cost storage rather than correctness.
      await audit(
        scope,
        artifactExported({
          exportId,
          collectionCount: EXPORT_COLLECTIONS.length,
          itemCount: manifest.itemCount,
          omissionCount: manifest.omissionCount,
          redactionCount: manifest.redactionCount,
          complete: manifest.complete,
          faithful: manifestIsFaithful(manifest),
          manifestDigest: sha256(manifestBytes),
        }),
        auditCtx,
      );

      // Opaque ids and counts only — never a collection's contents, and never a founder's data.
      options.logger?.info('export.generated', {
        metadata: { accountId, companyId, exportId, itemCount: manifest.itemCount, omissionCount: manifest.omissionCount, complete: manifest.complete },
      });

      return { status: 'ok', exportId, manifest, manifestKey: keyString(manifestKey) };
    },
    optsBase,
  );

  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}
