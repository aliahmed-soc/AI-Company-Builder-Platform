// @acbp/core — understanding generation use case (ACBP-P2-008; CDR-029; UNDER-001/005).
//
// Generate a classified, versioned business-understanding document from the company's confirmed/typed memory. The
// model call runs BETWEEN scoped operations (never in a held tx): read memory (its own memory:read scope) → call
// the P2-003 GATEWAY (injected, provider-neutral; fake in P2-008 — live is the deferred owner gate CDR-026 §0) →
// persist ONE immutable version + its items + the `understanding.generated` audit in a SINGLE company-scoped
// transaction (audit-or-nothing). A gateway failure or malformed output persists NOTHING. Review/confirm is P2-009.
import { UnderstandingRepository, writeAuditEvent, type DatabaseClient, type AuditScope, type AuditWriteContext, type UnderstandingDocumentRow } from '@acbp/database';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import { listMemoryItems } from '../memory/memory-item.js';
import {
  understandingGenerated,
  parseUnderstanding,
  computeSections,
  overallConfidence,
  resolveTemplateRef,
  renderTemplateSegments,
  templateRef,
  timeoutClassForTask,
  UNDERSTANDING_SCHEMA,
  type AuditEvent,
  type DocumentStatus,
  type ModelContextPart,
  type ModelGatewayRequest,
  type ModelGatewayResult,
  type MemoryItemDTO,
  type UnderstandingItemInput,
  type UnderstandingSection,
} from '@acbp/contracts';
import type { Logger } from '@acbp/observability';

type AuditWriteFn = (scope: AuditScope, event: AuditEvent, ctx?: AuditWriteContext) => Promise<string>;
export type ModelGateway = (request: ModelGatewayRequest, options?: { readonly correlationId?: string }) => Promise<ModelGatewayResult>;

export interface GenerateUnderstandingParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
}
export interface UnderstandingGenerationDeps {
  readonly gateway: ModelGateway;
  readonly logger?: Logger;
}
export interface UnderstandingGenerationOptions {
  readonly correlationId?: string;
  /** TEST SEAM ONLY: override the in-tx audit writer to force a failure (prove persist rolls back). */
  readonly auditWriter?: AuditWriteFn;
}

export interface UnderstandingSectionDTO {
  readonly class: string;
  readonly count: number;
  readonly confidence: number;
  readonly status: string;
}
export interface UnderstandingItemDTO {
  readonly class: string;
  readonly content: string;
  readonly confidence: number;
}
export interface UnderstandingDocumentDTO {
  readonly documentId: string;
  readonly version: number;
  readonly status: DocumentStatus;
  readonly overallConfidence: number;
  readonly sections: readonly UnderstandingSectionDTO[];
  readonly items: readonly UnderstandingItemDTO[];
  readonly createdAt: string;
}

export type GenerateUnderstandingResult =
  | { readonly status: 'ok'; readonly document: UnderstandingDocumentDTO }
  | { readonly status: 'forbidden' }
  | { readonly status: 'generation_failed' };

const MEMORY_PROMPT_MAX = 12_000;
/** Bounded retries for the version-assignment race (a concurrent generation may take the computed version). */
const MAX_VERSION_ATTEMPTS = 5;

/** Format the confirmed memory items into the bounded `{{memory}}` prompt text (type-labeled, no ids/PII). */
export function formatMemoryForPrompt(items: readonly MemoryItemDTO[]): string {
  if (items.length === 0) return 'No confirmed information yet.';
  return items.map((i) => `- [${i.type}] ${i.content}`).join('\n').slice(0, MEMORY_PROMPT_MAX);
}

/** Build the understanding-generation gateway request (pins the registered template + output schema). */
export function buildUnderstandingRequest(input: { accountId: string; companyId: string; memory: string; correlationId?: string }): ModelGatewayRequest {
  const def = resolveTemplateRef('understanding.generate@1');
  const contextParts: ModelContextPart[] = renderTemplateSegments(def, { memory: input.memory }).map((s) => ({ role: s.role, content: s.text }));
  return {
    taskClass: def.taskClass,
    templateRef: templateRef(def),
    contextParts,
    outputSchemaRef: UNDERSTANDING_SCHEMA,
    timeoutClass: timeoutClassForTask(def.taskClass),
    companyId: input.companyId,
    accountId: input.accountId,
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  };
}

/** Narrow the gateway's validated output to the understanding item list + partial flag (defensive re-check). */
function validItems(validatedOutput: unknown): { items: readonly UnderstandingItemInput[]; partial: boolean } | undefined {
  const parsed = parseUnderstanding(typeof validatedOutput === 'string' ? validatedOutput : JSON.stringify(validatedOutput ?? {}));
  return parsed.ok ? parsed.value : undefined;
}

function sectionDTO(s: UnderstandingSection): UnderstandingSectionDTO {
  return { class: s.class, count: s.count, confidence: s.confidence, status: s.status };
}

export async function generateUnderstanding(client: DatabaseClient, params: GenerateUnderstandingParams, deps: UnderstandingGenerationDeps, options: UnderstandingGenerationOptions = {}): Promise<GenerateUnderstandingResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const optsBase = { ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}), ...(deps.logger !== undefined ? { logger: deps.logger } : {}) };

  // 1. Read the confirmed/typed memory (its own memory:read scope).
  const mem = await listMemoryItems(client, { userId: params.userId, accountId: params.accountId, companyId: params.companyId, currentOnly: true }, optsBase);
  if (mem.status === 'forbidden') return { status: 'forbidden' };
  const memoryText = formatMemoryForPrompt(mem.items);

  // 2. Call the gateway (external; its own usage-metering tx). Model call BETWEEN scoped operations.
  const request = buildUnderstandingRequest({ accountId: params.accountId, companyId: params.companyId, memory: memoryText, ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}) });
  const result = await deps.gateway(request, options.correlationId !== undefined ? { correlationId: options.correlationId } : {});

  // 3. A gateway failure OR malformed output persists NOTHING (never a partial-looking document from a failure).
  if (result.outcome !== 'ok') return { status: 'generation_failed' };
  const parsed = validItems(result.validatedOutput);
  if (parsed === undefined) return { status: 'generation_failed' };

  const status: DocumentStatus = parsed.partial ? 'partial' : 'complete';
  const sections = computeSections(parsed.items);
  const confidence = overallConfidence(sections);

  // 4. Persist the version + items + audit in ONE company-scoped transaction (audit-or-nothing).
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<GenerateUnderstandingResult> => {
      if (checkAuthorization(role, 'understanding:generate', { accountId: params.accountId, actorId: params.userId }, optsBase).kind === 'deny') return { status: 'forbidden' };
      const repo = new UnderstandingRepository(scope.db);
      // Assign the next version race-safely: a concurrent generation may take the same computed version, so the
      // insert is ON CONFLICT DO NOTHING (returns undefined) and we recompute + retry — a valid, gap-free chain,
      // never an uncaught duplicate-key throw (review L1).
      let doc: UnderstandingDocumentRow | undefined;
      for (let attempt = 0; attempt < MAX_VERSION_ATTEMPTS && doc === undefined; attempt += 1) {
        const version = await repo.nextVersion(params.companyId);
        doc = await repo.insertDocument({ accountId: params.accountId, companyId: params.companyId, version, status, overallConfidence: confidence, createdByUserId: params.userId });
      }
      if (doc === undefined) return { status: 'generation_failed' }; // extreme concurrent contention — nothing persisted
      const itemDTOs: UnderstandingItemDTO[] = [];
      for (const it of parsed.items) {
        await repo.insertItem({ accountId: params.accountId, companyId: params.companyId, documentId: doc.id, itemClass: it.class, content: it.content, confidence: it.confidence, sourceRef: null });
        itemDTOs.push({ class: it.class, content: it.content, confidence: it.confidence });
      }
      // understanding.generated in the SAME transaction — an audit failure rolls the whole document+items back.
      await audit(scope, understandingGenerated({ documentId: doc.id, version: doc.version, status, itemCount: parsed.items.length }), options.correlationId !== undefined ? { correlationId: options.correlationId } : {});
      deps.logger?.info('understanding.generated', { metadata: { accountId: params.accountId, companyId: params.companyId, version: doc.version, status, itemCount: parsed.items.length } });
      return { status: 'ok', document: toDocumentDTO(doc, sections, itemDTOs) };
    },
    optsBase,
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

function toDocumentDTO(row: UnderstandingDocumentRow, sections: readonly UnderstandingSection[], items: readonly UnderstandingItemDTO[]): UnderstandingDocumentDTO {
  return {
    documentId: row.id,
    version: row.version,
    status: row.status as DocumentStatus,
    overallConfidence: row.overall_confidence,
    sections: sections.map(sectionDTO),
    items,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
