// @acbp/core — artifact persistence (ACBP-P5-011; CDR-060; TASK-005; NFR-014; trust-critical #2).
//
// ONE RULE ORGANISES THIS WHOLE MODULE: an artifact is not persisted until the object is proven to be there, and the
// metadata row is written only after that proof. `FAILURE-AND-RECOVERY` row 7 and `WORKFLOW-STATE-MACHINES` line 60
// both put it the same way — *"persistence failure ⇒ failed, never hollow success"*.
//
// So the order is fixed and deliberate:
//
//   validate → derive the key → PUT → READ BACK → insert the row
//
// Object first, row second. Reversing it would create a row pointing at nothing, which every downstream reader would
// believe. Failing between the two leaves an orphaned object instead — unreferenced bytes, which cost storage and
// nothing else. Of the two possible inconsistencies, only one lies to the founder, and this order picks the other.
//
// THERE IS NO AUDIT EVENT HERE, and that is not an omission. Canon registers `artifact.exported` (the export module)
// and nothing for creation; the fact that becomes visible is `task.completed`, which carries the artifact count and
// is written by the completion path. Inventing an `artifact.created` event would be inventing a requirement.
import { createHash } from 'node:crypto';
import { ArtifactRepository, TaskRunRepository, type ArtifactRow, type DatabaseClient } from '@acbp/database';
import {
  artifactObjectKey,
  keyString,
  validateArtifact,
  verifyKeyBelongsToCompany,
  verifyPersistedObject,
  type ArtifactFormat,
  type ArtifactProvenance,
  type ArtifactRefusal,
  type ObjectStorage,
  type ObjectVerificationFailure,
} from '@acbp/contracts';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import type { Logger } from '@acbp/observability';

export interface PersistArtifactOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
}

export interface PersistArtifactParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  /** Provenance (CDR-060 G6). Every field required — an artifact of unknown origin cannot be trusted or revised. */
  readonly runId: string;
  readonly workerId: string;
  readonly workerVersion: number;
  readonly modelVersion: string;
  readonly title: string;
  readonly format: ArtifactFormat;
  /** The content itself. A string is encoded as UTF-8; bytes are stored as given. */
  readonly content: string | Uint8Array;
}

export interface ArtifactDTO {
  readonly id: string;
  readonly objectKey: string;
  readonly contentHash: string;
  readonly format: string;
  readonly sizeBytes: number;
  readonly runId: string;
  readonly workerId: string;
  readonly workerVersion: number;
  readonly modelVersion: string;
  readonly title: string;
}

export type PersistArtifactResult =
  | { readonly status: 'ok'; readonly artifact: ArtifactDTO; readonly deduplicated: boolean }
  | { readonly status: 'forbidden' }
  | { readonly status: 'refused'; readonly reason: ArtifactRefusal | 'key_derivation_failed' }
  /** The cited run does not exist in this company. Checked BEFORE the write — see the note in `persistArtifact`. */
  | { readonly status: 'run_not_found' }
  /** The write itself failed. TASK-005: the task fails. */
  | { readonly status: 'storage_failed' }
  /** The write REPORTED success and the object is not really there, or not whole. Also a task failure. */
  | { readonly status: 'storage_unverified'; readonly reason: ObjectVerificationFailure };

const CONTENT_TYPES: Readonly<Record<ArtifactFormat, string>> = { markdown: 'text/markdown', json: 'application/json', text: 'text/plain' };

function toDTO(row: ArtifactRow): ArtifactDTO {
  return {
    id: row.id,
    objectKey: row.object_key,
    contentHash: row.content_hash,
    format: row.format,
    sizeBytes: row.size_bytes,
    runId: row.run_id,
    workerId: row.worker_id,
    workerVersion: row.worker_version,
    modelVersion: row.model_version,
    title: row.title,
  };
}

function optionsFor(options: PersistArtifactOptions): { correlationId?: string; logger?: Logger } {
  const o: { correlationId?: string; logger?: Logger } = {};
  if (options.correlationId !== undefined) o.correlationId = options.correlationId;
  if (options.logger !== undefined) o.logger = options.logger;
  return o;
}

/**
 * Persist one artifact: its bytes to object storage, its provenance to the database.
 *
 * The refusals are TYPED and the caller's job on any of them is to FAIL THE TASK. Nothing here throws for an expected
 * condition, because a thrown error is the thing most likely to be caught and logged by a worker that then reports
 * success anyway.
 */
export async function persistArtifact(client: DatabaseClient, storage: ObjectStorage, params: PersistArtifactParams, options: PersistArtifactOptions = {}): Promise<PersistArtifactResult> {
  const bytes = typeof params.content === 'string' ? new TextEncoder().encode(params.content) : params.content;
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const provenance: ArtifactProvenance = { runId: params.runId, workerId: params.workerId, workerVersion: params.workerVersion, modelVersion: params.modelVersion };

  const validation = validateArtifact({ companyId: params.companyId, format: params.format, sizeBytes: bytes.byteLength, contentHash, provenance });
  if (!validation.ok) return { status: 'refused', reason: validation.reason };

  const derived = artifactObjectKey(params.companyId, contentHash, params.format);
  if (!derived.ok) return { status: 'refused', reason: 'key_derivation_failed' };
  const key = derived.value;
  // RE-VERIFIED AT USE (CDR-048 §3-G3), not only at construction. Construction is one function call away, but this
  // costs nothing and it is the check that would catch a future refactor handing us a key from somewhere else.
  if (!verifyKeyBelongsToCompany(keyString(key), params.companyId)) return { status: 'refused', reason: 'key_derivation_failed' };

  const ran = await runInCompanyScope(client, { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId }, async (scope, role): Promise<PersistArtifactResult> => {
    // AUTHORIZED BEFORE ANYTHING IS WRITTEN — including before the object write. An unauthorized caller must not be
    // able to place bytes in a company's prefix even if the row is refused afterwards.
    if (checkAuthorization(role, 'run:execute', { accountId: params.accountId, actorId: params.userId }, optionsFor(options)).kind === 'deny') return { status: 'forbidden' };

    // THE RUN IS CHECKED BEFORE THE OBJECT IS WRITTEN. The tenant-pinned composite FK would refuse a cross-company
    // run anyway, but only at the INSERT — by which point the bytes are already in the bucket, so the caller would
    // get a raw constraint error and the write would leave an orphan. Review pass 1: a positive read here is both a
    // typed refusal and one fewer orphaned object. The read is RLS-confined, so "not in this company" and "does not
    // exist" are correctly the same answer.
    if ((await new TaskRunRepository(scope.db).findById(params.runId)) === undefined) return { status: 'run_not_found' };

    try {
      await storage.put({ key, body: bytes, contentType: CONTENT_TYPES[params.format] });
    } catch {
      // The provider's exception text is never surfaced or logged here — it is third-party text that can carry
      // request ids, bucket names and occasionally credentials.
      return { status: 'storage_failed' };
    }

    // THE READ-BACK. `put` resolving is the provider's claim; this is the check. A provider that silently dropped or
    // truncated the write is caught here, and the row is never written.
    let head;
    try {
      head = await storage.head(key);
    } catch {
      return { status: 'storage_unverified', reason: 'unreadable' };
    }
    const verified = verifyPersistedObject(head, bytes.byteLength);
    if (!verified.ok) return { status: 'storage_unverified', reason: verified.reason };

    const repository = new ArtifactRepository(scope.db);
    const before = await repository.findByContentForRun(params.companyId, contentHash, params.runId);
    const row = await repository.insert({
      accountId: params.accountId,
      companyId: params.companyId,
      objectKey: keyString(key),
      contentHash,
      format: params.format,
      sizeBytes: bytes.byteLength,
      runId: params.runId,
      workerId: params.workerId,
      workerVersion: params.workerVersion,
      modelVersion: params.modelVersion,
      title: params.title,
    });
    // `deduplicated` reports the one outcome that creates no new row — the same run re-writing the same bytes — which
    // is a SUCCESS the caller may want to distinguish from a first write, and would otherwise leave no trace at all.
    //
    // ADVISORY, not authoritative: two concurrent writers of the same bytes can both read `undefined` here and both
    // report `false`, while the unique index still guarantees exactly one row. That is the correct trade — the flag
    // is reporting, and tightening it would mean holding a lock across an object write.
    return { status: 'ok', artifact: toDTO(row), deduplicated: before !== undefined };
  }, optionsFor(options));
  // A scope that could not be established is a REFUSAL, never a pass-through: the caller has no membership in this
  // company, which is indistinguishable from being unauthorized and must be reported as such.
  return ran.kind === 'ran' ? ran.value : { status: 'forbidden' };
}

/** Read one artifact's metadata. The BYTES are fetched separately through a signed URL (CDR-060 G5). */
export async function getArtifact(client: DatabaseClient, params: { readonly userId: string; readonly accountId: string; readonly companyId: string; readonly artifactId: string }, options: PersistArtifactOptions = {}): Promise<ArtifactDTO | 'forbidden' | 'not_found'> {
  const ran = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<ArtifactDTO | 'forbidden' | 'not_found'> => {
      if (checkAuthorization(role, 'task:read', { accountId: params.accountId, actorId: params.userId }, optionsFor(options)).kind === 'deny') return 'forbidden';
      const row = await new ArtifactRepository(scope.db).findById(params.artifactId);
      return row === undefined ? 'not_found' : toDTO(row);
    },
    optionsFor(options),
  );
  return ran.kind === 'ran' ? ran.value : 'forbidden';
}

/** Every artifact one run produced — the set `task.completed`'s `run_id` makes reachable (see `taskCompleted`). */
export async function listRunArtifacts(client: DatabaseClient, params: { readonly userId: string; readonly accountId: string; readonly companyId: string; readonly runId: string }, options: PersistArtifactOptions = {}): Promise<readonly ArtifactDTO[] | 'forbidden'> {
  const ran = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<readonly ArtifactDTO[] | 'forbidden'> => {
      if (checkAuthorization(role, 'task:read', { accountId: params.accountId, actorId: params.userId }, optionsFor(options)).kind === 'deny') return 'forbidden';
      return (await new ArtifactRepository(scope.db).listForRun(params.runId)).map(toDTO);
    },
    optionsFor(options),
  );
  return ran.kind === 'ran' ? ran.value : 'forbidden';
}
