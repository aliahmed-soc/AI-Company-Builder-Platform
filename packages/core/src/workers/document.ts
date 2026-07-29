// @acbp/core — the document worker (ACBP-P5-008; CDR-063; WORK-004; ADR-012/019).
//
//   authorize → gateway → parse → ASSESS → persist (either way) → report the status
//
// THE ASSESSMENT DOES NOT GATE THE PERSIST, and that is this worker's whole shape. Research refuses rather than store
// an invented citation; strategy asks rather than pad a comparison; this one KEEPS a failing draft, because a
// half-finished business plan is editable and throwing it away costs the founder work they could have used.
//
// What it must never do is present that draft as finished — so the status is DERIVED from the document (never taken
// from the model, which would always say `complete`) and written into the artifact's own bytes, above the content.
//
// Internal tools only: no fetch, no untrusted content, no injection screen. Like the strategy worker and unlike
// research, and that absence is a property to state rather than an omission to notice later.
import type { DatabaseClient } from '@acbp/database';
import {
  DOCUMENT_SCHEMA,
  assessDocumentQuality,
  parseDocumentOutput,
  renderDocumentMarkdown,
  renderTemplateSegments,
  resolveTemplateRef,
  templateRef,
  timeoutClassForTask,
  type DocumentRefusal,
  type DocumentQualityStatus,
  type DocumentType,
  type ModelContextPart,
  type ModelGatewayRequest,
  type ObjectStorage,
} from '@acbp/contracts';
import { persistArtifact, type ArtifactDTO } from '../artifacts/persist.js';
import type { ResearchModelGateway } from './research.js';
import type { Logger } from '@acbp/observability';

const CONTEXT_PROMPT_MAX = 16_000;
/** Well inside the database's 500-character title bound. */
const ARTIFACT_TITLE_MAX = 200;

export interface DocumentWorkerDeps {
  readonly gateway: ResearchModelGateway;
  readonly storage: ObjectStorage;
  readonly logger?: Logger;
}

export interface RunDocumentParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly runId: string;
  readonly documentType: DocumentType;
  /** What the founder asked for. */
  readonly brief: string;
  /** The approved context, already assembled by the caller. */
  readonly context: string;
  readonly workerVersion: number;
  readonly modelVersion: string;
}

export interface RunDocumentOptions {
  readonly correlationId?: string;
}

export type RunDocumentResult =
  /**
   * The document was written. `status` says whether it is finished or a flagged draft — BOTH are `ok`, because both
   * produced an artifact the founder can open and edit.
   */
  | { readonly status: 'ok'; readonly artifact: ArtifactDTO; readonly documentStatus: DocumentQualityStatus; readonly failingSections: readonly string[] }
  | { readonly status: 'blank_brief' }
  | { readonly status: 'generation_failed' }
  /** The output was not a structured document at all — no sections, no provenance, or the wrong shape. */
  | { readonly status: 'unusable_output'; readonly reason: DocumentRefusal; readonly index: number | null }
  | { readonly status: 'persist_failed'; readonly reason: string };

/** Build the document gateway request (pins the registered template + output schema). */
export function buildDocumentRequest(input: { accountId: string; companyId: string; documentType: DocumentType; brief: string; context: string; correlationId?: string }): ModelGatewayRequest {
  const def = resolveTemplateRef('document.generate@1');
  const contextParts: ModelContextPart[] = renderTemplateSegments(def, {
    document_type: input.documentType,
    brief: input.brief,
    context: input.context.slice(0, CONTEXT_PROMPT_MAX),
  }).map((s) => ({ role: s.role, content: s.text }));
  return {
    taskClass: def.taskClass,
    templateRef: templateRef(def),
    contextParts,
    outputSchemaRef: DOCUMENT_SCHEMA,
    timeoutClass: timeoutClassForTask(def.taskClass),
    companyId: input.companyId,
    accountId: input.accountId,
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  };
}

export async function runDocumentWorker(client: DatabaseClient, params: RunDocumentParams, deps: DocumentWorkerDeps, options: RunDocumentOptions = {}): Promise<RunDocumentResult> {
  if (typeof params.brief !== 'string' || params.brief.trim() === '') return { status: 'blank_brief' };

  const request = buildDocumentRequest({
    accountId: params.accountId,
    companyId: params.companyId,
    documentType: params.documentType,
    brief: params.brief,
    context: params.context,
    ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
  });
  const result = await deps.gateway(request, options.correlationId !== undefined ? { correlationId: options.correlationId } : {});
  if (result.outcome !== 'ok') return { status: 'generation_failed' };

  // Re-narrowed defensively across the seam: "something upstream validated this" is not a reason to trust a value
  // that arrived corrupted.
  const parsed = parseDocumentOutput(result.validatedOutput);
  if (!parsed.ok) return { status: 'unusable_output', reason: parsed.reason, index: parsed.index };

  // DERIVED, never supplied. A model permitted to declare its own document finished always would.
  const assessment = assessDocumentQuality(parsed.document);

  // AND PERSISTED EITHER WAY. This is the one place among the three workers where refusing would be the wrong answer.
  const title = parsed.document.title.trim().slice(0, ARTIFACT_TITLE_MAX);
  const persisted = await persistArtifact(
    client,
    deps.storage,
    {
      userId: params.userId,
      accountId: params.accountId,
      companyId: params.companyId,
      runId: params.runId,
      workerId: 'document',
      workerVersion: params.workerVersion,
      modelVersion: params.modelVersion,
      title,
      format: 'markdown',
      content: renderDocumentMarkdown(parsed.document, assessment),
    },
    options.correlationId !== undefined ? { correlationId: options.correlationId } : {},
  );
  if (persisted.status !== 'ok') return { status: 'persist_failed', reason: persisted.status };
  return { status: 'ok', artifact: persisted.artifact, documentStatus: assessment.status, failingSections: assessment.failingSections };
}
