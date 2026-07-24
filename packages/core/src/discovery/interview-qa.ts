// @acbp/core — interview Q&A persistence use cases (ACBP-P2-002; CDR-023; DISC-008 persistence).
//
// The question/answer persistence layer on the P2-001 interview session. Every op runs under the caller's
// validated CompanyScope (runInCompanyScope) on the restricted acbp_app role: the caller's ACTIVE
// company-membership role is resolved first, the ADR-022 role check gates the action (interview:participate for
// writes, interview:read for the read — any active company member), and the mutation runs RLS-confined to the
// company. Questions are IMMUTABLE (append a new one; never edit); answers are APPEND-ONLY (a revision is a new
// row). Resubmitting the identical current answer is an idempotent no-op (no new revision).
//
// Persistence-only (CDR-023 §4): NO audit-store event and NO domain event are emitted — accountability lives in
// the append-only, authored, timestamped rows; the audited correction (`understanding.corrected`) and the
// `interview.question_answered` fan-out are deferred to M3 when their consumers + the outbox exist.
import { InterviewQaRepository, InterviewSessionRepository, type DatabaseClient, type InterviewQuestionRow, type InterviewAnswerRow } from '@acbp/database';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import {
  validateAnswerSubmission,
  isSameAnswer,
  currentRevision,
  deriveQuestionLifecycle,
  isAnswerStatus,
  isQuestionSource,
  validationError,
  type AnswerDTO,
  type QuestionDTO,
  type QuestionWithAnswerDTO,
  type SessionQADTO,
  type QuestionSource,
  type PublicErrorEnvelope,
} from '@acbp/contracts';
import type { MemberRole } from '../members/roles.js';
import type { Logger } from '@acbp/observability';

export interface InterviewQaParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly sessionId: string;
}
export interface InterviewQaOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
}

export type AddQuestionResult = { readonly status: 'ok'; readonly question: QuestionDTO } | { readonly status: 'forbidden' } | { readonly status: 'not_found' } | { readonly status: 'validation'; readonly error: PublicErrorEnvelope };
export type RecordAnswerResult =
  | { readonly status: 'ok'; readonly answer: AnswerDTO; readonly created: boolean }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  | { readonly status: 'validation'; readonly error: PublicErrorEnvelope };
export type GetSessionQaResult = { readonly status: 'ok'; readonly qa: SessionQADTO } | { readonly status: 'forbidden' } | { readonly status: 'not_found' };

const PROMPT_MAX = 4_000;
/** Rationale bound (matches the migration-0018 CHECK). */
const RATIONALE_MAX = 1_000;
/** Bounded append retries under concurrent revision contention (see recordInterviewAnswer). */
const MAX_APPEND_ATTEMPTS = 5;

// ── add a question (the persistence primitive; P2-005 drives generation) ───────────────────────────────
export async function addInterviewQuestion(client: DatabaseClient, params: InterviewQaParams & { prompt: unknown; rationale?: unknown; source?: unknown }, options: InterviewQaOptions = {}): Promise<AddQuestionResult> {
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<AddQuestionResult> => {
      if (checkAuthorization(role, 'interview:participate', { accountId: params.accountId, actorId: params.userId }, options).kind === 'deny') return { status: 'forbidden' };
      if (typeof params.prompt !== 'string' || params.prompt.length === 0 || params.prompt.length > PROMPT_MAX) {
        return { status: 'validation', error: validationError({ message: 'Question prompt is invalid.', fields: ['prompt'] }).toPublic() };
      }
      // Adaptive-orchestration metadata (ACBP-P2-005): a bounded "why we ask" rationale and the closed source.
      // Both optional (the P2-002 primitive omits them → null rationale + DB-default 'adaptive' source).
      if (params.rationale !== undefined && params.rationale !== null && (typeof params.rationale !== 'string' || params.rationale.length === 0 || params.rationale.length > RATIONALE_MAX)) {
        return { status: 'validation', error: validationError({ message: 'Question rationale is invalid.', fields: ['rationale'] }).toPublic() };
      }
      if (params.source !== undefined && !isQuestionSource(params.source)) {
        return { status: 'validation', error: validationError({ message: 'Question source is invalid.', fields: ['source'] }).toPublic() };
      }
      // The session must be visible in this scope (RLS) before a question can attach to it.
      const session = await new InterviewSessionRepository(scope.db).findById(params.sessionId);
      if (session === undefined) return { status: 'not_found' };
      const repo = new InterviewQaRepository(scope.db);
      const position = await repo.nextQuestionPosition(params.sessionId);
      const rationale = typeof params.rationale === 'string' ? params.rationale : null;
      const source: QuestionSource | undefined = isQuestionSource(params.source) ? params.source : undefined;
      const row = await repo.insertQuestion(params.accountId, params.companyId, params.sessionId, position, params.prompt, rationale, source);
      return { status: 'ok', question: toQuestionDTO(row) };
    },
    optionsFor(options),
  );
  return unwrap(run);
}

// ── record / revise an answer (append-only; idempotent no-op on identical resubmit) ─────────────────────
export async function recordInterviewAnswer(client: DatabaseClient, params: InterviewQaParams & { questionId: string; status: unknown; content?: unknown }, options: InterviewQaOptions = {}): Promise<RecordAnswerResult> {
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<RecordAnswerResult> => {
      if (checkAuthorization(role, 'interview:participate', { accountId: params.accountId, actorId: params.userId }, options).kind === 'deny') return { status: 'forbidden' };
      const submission = validateAnswerSubmission({ status: params.status, content: params.content });
      if (!submission.ok) return { status: 'validation', error: submission.error };

      const repo = new InterviewQaRepository(scope.db);
      // The question must exist AND belong to the named session (RLS already confines to the company).
      const question = await repo.findQuestion(params.questionId);
      if (question === undefined || question.session_id !== params.sessionId) return { status: 'not_found' };

      // Bounded retry so a CONCURRENT DISTINCT answer is never dropped (security review LOW): the
      // (question_id, revision) PK + ON CONFLICT DO NOTHING serializes writers on the revision number. On a
      // conflict we re-read the new current answer and re-evaluate — if the winner wrote the SAME content we
      // intended, this becomes the idempotent no-op; if the winner wrote DIFFERENT content, our answer appends
      // at the next revision (both are retained — the append-only history the ticket guarantees). CDR-023 §2.
      for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
        const current = await repo.currentAnswer(params.questionId);
        if (current !== undefined && isSameAnswer({ status: assertStatus(current.status), content: current.content }, submission.value)) {
          return { status: 'ok', answer: toAnswerDTO(current), created: false };
        }
        const nextRev = (current?.revision ?? 0) + 1;
        const inserted = await repo.appendAnswer({
          accountId: params.accountId,
          companyId: params.companyId,
          sessionId: params.sessionId,
          questionId: params.questionId,
          revision: nextRev,
          status: submission.value.status,
          content: submission.value.content,
          authorUserId: params.userId,
        });
        if (inserted !== undefined) {
          options.logger?.info('interview.answer_recorded', { metadata: { accountId: params.accountId, companyId: params.companyId, revision: nextRev } });
          return { status: 'ok', answer: toAnswerDTO(inserted), created: true };
        }
        // Conflict: a concurrent writer took `nextRev`. Loop to re-read and re-evaluate.
      }
      // Extreme contention exhausted the retries — return the current answer truthfully (never a 500).
      const final = await repo.currentAnswer(params.questionId);
      return final !== undefined ? { status: 'ok', answer: toAnswerDTO(final), created: false } : { status: 'not_found' };
    },
    optionsFor(options),
  );
  return unwrap(run);
}

// ── read the session's Q&A (questions + current answers + full revision history) ────────────────────────
export async function getSessionQa(client: DatabaseClient, params: InterviewQaParams, options: InterviewQaOptions = {}): Promise<GetSessionQaResult> {
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<GetSessionQaResult> => {
      if (checkAuthorization(role, 'interview:read', { accountId: params.accountId, actorId: params.userId }, options).kind === 'deny') return { status: 'forbidden' };
      const session = await new InterviewSessionRepository(scope.db).findById(params.sessionId);
      if (session === undefined) return { status: 'not_found' };
      const repo = new InterviewQaRepository(scope.db);
      const questions = await repo.listQuestions(params.sessionId);
      const allAnswers = await repo.listAnswersForSession(params.sessionId);
      const byQuestion = new Map<string, InterviewAnswerRow[]>();
      for (const a of allAnswers) byQuestion.set(a.question_id, [...(byQuestion.get(a.question_id) ?? []), a]);
      const items: QuestionWithAnswerDTO[] = questions.map((q) => {
        const revs = byQuestion.get(q.id) ?? [];
        const cur = currentRevision(revs);
        return {
          question: toQuestionDTO(q),
          currentAnswer: cur === null ? null : toAnswerDTO(cur),
          revisions: revs.map(toAnswerDTO),
          lifecycle: deriveQuestionLifecycle(cur === null ? null : { status: assertStatus(cur.status) }),
        };
      });
      return { status: 'ok', qa: { sessionId: params.sessionId, items } };
    },
    optionsFor(options),
  );
  return unwrap(run);
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────
function optionsFor(options: InterviewQaOptions): { correlationId?: string; logger?: Logger } {
  const o: { correlationId?: string; logger?: Logger } = {};
  if (options.correlationId !== undefined) o.correlationId = options.correlationId;
  if (options.logger !== undefined) o.logger = options.logger;
  return o;
}
function toQuestionDTO(row: InterviewQuestionRow): QuestionDTO {
  return { questionId: row.id, position: row.position, prompt: row.prompt, rationale: row.rationale, source: assertSource(row.source), createdAt: new Date(row.created_at).toISOString() };
}
/** The DB CHECK guarantees a valid source; coerce defensively (an out-of-set value would be data corruption). */
function assertSource(value: string): QuestionSource {
  return isQuestionSource(value) ? value : 'adaptive';
}
function toAnswerDTO(row: InterviewAnswerRow): AnswerDTO {
  return { questionId: row.question_id, revision: row.revision, status: assertStatus(row.status), content: row.content, createdAt: new Date(row.created_at).toISOString() };
}
/** The DB CHECK guarantees a valid status; coerce defensively (an out-of-set value would be data corruption). */
function assertStatus(value: string): 'answered' | 'skipped' {
  return isAnswerStatus(value) ? value : 'answered';
}
function unwrap<T extends { status: string }>(run: { kind: 'ran'; value: T; role: MemberRole } | { kind: 'denied'; reason: string }): T | { status: 'forbidden' } {
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}
