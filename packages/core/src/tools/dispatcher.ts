// @acbp/core — THE tool dispatcher (ACBP-P5-003b; CDR-054; TOOL-002/003; WORK-005; ADR-012; trust-critical #4/#11).
//
// THIS IS THE ONLY PATH TO A TOOL. `COMPONENT-CATALOG` calls it *"Trusted — the enforcement chokepoint"*, and the
// claim is only true if nothing else can execute a tool: a capability with no dispatcher path does not run at all.
//
// It does NOT execute anything itself. In Phase 5 no tool implementation exists, and even once they do, running the
// call is the worker runtime's job (P5-005). What lives here is the decision, the record, and the refusal — which is
// exactly the part that must not be duplicated anywhere else.
//
// WHY THE RECORD COMES FIRST. TOOL-002 wants 100% of calls recorded, and a row written after execution cannot exist
// for a call that died mid-flight — precisely the call worth having a record of. So an authorized call is inserted
// `requested` before it is handed back, and `reportToolCallOutcome` closes it later.
import { ToolCallRepository, TaskRunRepository, writeAuditEvent, type DatabaseClient, type AuditWriteContext, type ToolCallRow } from '@acbp/database';
import { createHash } from 'node:crypto';
import {
  decideDispatch,
  canonicalizeToolArguments,
  hasUntrustedContext,
  hasExternalEffect,
  detectInjection,
  isToolCallOutcome,
  toolCallRequested,
  toolCallCompleted,
  type GateAnswer,
  type StopAnswer,
  type ToolDenialReason,
} from '@acbp/contracts';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import type { Logger } from '@acbp/observability';

/** Phase 5 defaults for the three gate ports. See `ToolGates` for why stop is `clear` and the others are not. */
const CLEAR = (): StopAnswer => ({ kind: 'clear' });
const NO_ANSWER = (): GateAnswer => ({ kind: 'unavailable' });

/**
 * The gates the dispatcher consults. All three are PORTS with fail-closed Phase 5 defaults, because the engines
 * behind them are Phase 6's (`IMPLEMENTATION-ROADMAP §M5`).
 *
 * `stop` defaults to `clear` and the other two to `unavailable`, and the asymmetry is deliberate: with no stop
 * mechanism in existence, no stop CAN be in force, so `clear` is simply true. A policy engine that does not exist has
 * not evaluated anything, which is a missing answer rather than a permissive one.
 */
export interface ToolGates {
  readonly policy?: () => Promise<GateAnswer> | GateAnswer;
  readonly approval?: () => Promise<GateAnswer> | GateAnswer;
  readonly stop?: () => Promise<StopAnswer> | StopAnswer;
}

export interface DispatcherOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  readonly auditWriter?: typeof writeAuditEvent;
  readonly gates?: ToolGates;
}

export interface DispatchToolCallParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  /** A call BELONGS to a run (CDR-054 §1-G10). */
  readonly runId: string;
  readonly toolId: string;
  /** Digested here and never stored — TOOL-002 records an arguments DIGEST. */
  readonly args: unknown;
  /** The worker's allowlist. `undefined` means none was supplied, which REFUSES (WORK-005, §1-G3). */
  readonly allowlist: readonly string[] | undefined;
  readonly idempotencyKey?: string;
  /**
   * The working-context items this call was proposed alongside (ACBP-P5-003c; NFR-021; invariant 17).
   *
   * The ITEMS are passed, not a boolean: the dispatcher classifies them itself through `hasUntrustedContext`, which
   * treats anything unrecognised as untrusted. A caller-supplied flag would let a mistake upstream read as trusted,
   * and this is the one input where being wrong means untrusted content reached a tool. Nothing here is persisted —
   * only the arguments digest ever is.
   *
   * REQUIRED, not optional (review pass 1). An optional field defaults a FORGOTTEN context to the trusted path, and
   * this is the one input where being wrong means untrusted content reached a tool. A caller with genuinely no
   * context passes `[]` — a decision, rather than an omission that looks identical to one.
   */
  readonly context: readonly unknown[];
}

export interface ToolCallDTO {
  readonly id: string;
  readonly runId: string;
  readonly toolId: string;
  readonly toolVersion: number | null;
  readonly riskClass: string;
  readonly externalEffect: boolean;
  readonly outcome: string;
  readonly denialReason: string | null;
  readonly argumentsDigest: string;
}

function toDTO(row: ToolCallRow): ToolCallDTO {
  return {
    id: row.id,
    runId: row.run_id,
    toolId: row.tool_id,
    toolVersion: row.tool_version,
    riskClass: row.risk_class,
    externalEffect: row.external_effect,
    outcome: row.outcome,
    denialReason: row.denial_reason,
    argumentsDigest: row.arguments_digest,
  };
}

export type DispatchToolCallResult =
  // Cleared to run. The row already exists in `requested`; the caller reports the outcome afterwards.
  | { readonly status: 'authorized'; readonly call: ToolCallDTO }
  // Refused, AND RECORDED — TOOL-001: "attempts are audited". The reason says which gate refused.
  | { readonly status: 'denied'; readonly call: ToolCallDTO; readonly reason: ToolDenialReason }
  // NFR-006: this idempotency key already ran in this company. The first call's record is returned; nothing re-runs.
  | { readonly status: 'duplicate'; readonly call: ToolCallDTO }
  | { readonly status: 'forbidden' }
  | { readonly status: 'run_not_found' }
  // A run that is not `running` has no execution to attach a tool call to — the P5-002 pass-2 lesson, same shape.
  | { readonly status: 'run_not_running'; readonly runState: string };

/** sha256 of the canonical encoding. The arguments themselves never leave this function. */
export function digestToolArguments(args: unknown): string {
  return createHash('sha256').update(canonicalizeToolArguments(args), 'utf8').digest('hex');
}

/**
 * Propose a tool call. Returns an authorization or a refusal; NEVER throws for a refusal, because WORK-005's failure
 * clause is *"Rejection does not crash the task; it fails that step with reason."*
 */
export async function dispatchToolCall(client: DatabaseClient, params: DispatchToolCallParams, options: DispatcherOptions = {}): Promise<DispatchToolCallResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const argumentsDigest = digestToolArguments(params.args);
  // A BLANK KEY IS NO KEY (review pass 1). Treating '' as a real key would make two unrelated calls that both omitted
  // a meaningful one silently suppress each other - a duplicate answer for something that was never a duplicate.
  const idempotencyKey = (params.idempotencyKey ?? '').trim() === '' ? undefined : params.idempotencyKey;

  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<DispatchToolCallResult> => {
      // A tool call happens INSIDE a run's execution, so it needs the capability that executing a run needs. A
      // separate `tool:dispatch` action would be a second, coarser gate duplicating what the allowlist already does
      // per tool — least privilege here is the allowlist's job (WORK-005), not a broader role check's.
      if (checkAuthorization(role, 'run:execute', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };

      const runs = new TaskRunRepository(scope.db);
      // RLS-confined, so another company's run reads as absent — a foreign run is `run_not_found`, never a call
      // recorded against someone else's execution, and never an existence oracle.
      const taskRun = await runs.findById(params.runId);
      if (taskRun === undefined) return { status: 'run_not_found' };
      if (taskRun.state !== 'running') return { status: 'run_not_running', runState: taskRun.state };

      const untrusted = hasUntrustedContext(params.context);
      // Run the detector on the LIVE path, not only in tests (review pass 1). It never decides anything - provenance
      // already closed the gate - but a refusal that says WHICH signals the content matched is the difference between
      // a log line and something a human can act on, which is NFR-021's second half ('quarantines and flags').
      const signals = untrusted ? injectionSignalsIn(params.context) : '';
      const calls = new ToolCallRepository(scope.db);

      // Idempotency is checked BEFORE the gates. A duplicate is not a new call to authorize — re-running the gates
      // could even produce a different answer for a call that already happened, which would be a second, contradictory
      // record of one event (NFR-006; FAILURE-AND-RECOVERY row 11).
      if (idempotencyKey !== undefined) {
        const prior = await calls.findByIdempotencyKey(params.toolId, idempotencyKey);
        if (prior !== undefined) return { status: 'duplicate', call: toDTO(prior) };
      }

      // The registry: the ACTIVE definition, highest version. `undefined` means unregistered, which the decision
      // refuses; `risk_class` may be null, which resolves to the most restrictive class (TOOL-001).
      const definition = await scope.db
        .selectFrom('tool_definitions')
        .select(['risk_class', 'version'])
        .where('tool_id', '=', params.toolId)
        .where('status', '=', 'active')
        .orderBy('version', 'desc')
        .executeTakeFirst();

      const decision = decideDispatch({
        toolId: params.toolId,
        registered: definition !== undefined,
        riskClass: definition?.risk_class,
        allowlist: params.allowlist,
        untrustedContext: untrusted,
        stop: (await (options.gates?.stop ?? CLEAR)()) ?? { kind: 'unavailable' },
        policy: (await (options.gates?.policy ?? NO_ANSWER)()) ?? { kind: 'unavailable' },
        approval: (await (options.gates?.approval ?? NO_ANSWER)()) ?? { kind: 'unavailable' },
      });

      const externalEffect = hasExternalEffect(decision.riskClass);
      const inserted = await calls.insert({
        accountId: scope.tenant.accountId,
        companyId: scope.tenant.companyId,
        runId: params.runId,
        toolId: params.toolId,
        toolVersion: definition?.version ?? null,
        riskClass: decision.riskClass,
        externalEffect,
        outcome: decision.kind === 'denied' ? 'denied' : 'requested',
        denialReason: decision.kind === 'denied' ? decision.reason : null,
        argumentsDigest,
        idempotencyKey: idempotencyKey ?? null,
      });

      // The unique index fired between the read above and this insert: another caller claimed the key first. Report
      // the call that won rather than inventing a second record of the same event.
      if (inserted === undefined) {
        const winner = idempotencyKey === undefined ? undefined : await calls.findByIdempotencyKey(params.toolId, idempotencyKey);
        if (winner === undefined) throw new Error('tool call insert wrote nothing and no idempotent winner exists — invariant violated');
        return { status: 'duplicate', call: toDTO(winner) };
      }

      await audit(scope, requestedEvent(inserted, decision.kind === 'denied' ? decision.reason : null, signals), auditCtx(options));
      if (decision.kind === 'denied') {
        // Logged at WARN because a refusal at the chokepoint is the signal the platform alarms on (TOOL-003 asks for
        // owner notification on gate unavailability). Metadata is scalars only — no arguments, no digest.
        options.logger?.warn('tool.call_denied', { metadata: { companyId: params.companyId, toolId: params.toolId, reason: decision.reason, riskClass: decision.riskClass } });
        return { status: 'denied', call: toDTO(inserted), reason: decision.reason };
      }
      return { status: 'authorized', call: toDTO(inserted) };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── reporting the outcome ───────────────────────────────────────────────────────────────────────────────────

export interface ReportToolCallOutcomeParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly callId: string;
  /** `succeeded` · `failed` · `unconfirmed`. `denied` is the dispatcher's to write, never the caller's. */
  readonly outcome: string;
  /** Required to claim success on an external effect (TOOL-002). */
  readonly receiptRef?: string;
}

export type ReportToolCallOutcomeResult =
  | { readonly status: 'ok'; readonly call: ToolCallDTO }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  // Already reported. A second report is refused rather than applied — see below.
  | { readonly status: 'not_requested'; readonly outcome: string }
  | { readonly status: 'invalid' }
  // TOOL-002's failure clause, enforced here so the caller learns WHY rather than hitting a constraint error.
  | { readonly status: 'receipt_required' };

/**
 * Close a call with its outcome.
 *
 * THE GUARD ON `requested` IS THE POINT. Without it an `unconfirmed` external effect could be re-reported as
 * `succeeded` later — turning "we could not evidence this" into "this worked" with no new evidence, which is exactly
 * what TOOL-002's failure clause exists to prevent.
 */
export async function reportToolCallOutcome(client: DatabaseClient, params: ReportToolCallOutcomeParams, options: DispatcherOptions = {}): Promise<ReportToolCallOutcomeResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<ReportToolCallOutcomeResult> => {
      if (checkAuthorization(role, 'run:execute', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      // `requested` and `denied` are the dispatcher's own writes; a caller reporting either would be claiming an
      // outcome it did not have.
      if (!isToolCallOutcome(params.outcome) || params.outcome === 'requested' || params.outcome === 'denied') return { status: 'invalid' };

      const calls = new ToolCallRepository(scope.db);
      const current = await calls.findById(params.callId);
      if (current === undefined) return { status: 'not_found' };
      if (current.outcome !== 'requested') return { status: 'not_requested', outcome: current.outcome };
      // Blank is MISSING. A whitespace receipt satisfies a naive `is not null` while evidencing nothing, which is the
      // hollow success TOOL-002 exists to prevent — so it is normalized to null once, here, and judged as absent.
      const receipt: string | null = (params.receiptRef ?? '').trim() === '' ? null : (params.receiptRef ?? null);
      if (params.outcome === 'succeeded' && current.external_effect && receipt === null) return { status: 'receipt_required' };

      const updated = await calls.complete({
        callId: params.callId,
        outcome: params.outcome,
        // Blank is stored as NULL: a whitespace receipt evidences nothing, and keeping it would leave a value that
        // LOOKS like evidence in the column the receipt rule reads.
        receiptRef: receipt,
      });
      // The guard missed: something else closed the call between the read and the write. Re-read and report what it
      // actually became rather than claiming this report landed.
      if (updated === undefined) {
        const latest = await calls.findById(params.callId);
        return latest === undefined ? { status: 'not_found' } : { status: 'not_requested', outcome: latest.outcome };
      }

      await audit(scope, completedEvent(updated), auditCtx(options));
      return { status: 'ok', call: toDTO(updated) };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── audit events (the factories live in @acbp/contracts, so the registry types them) ─────────────────────────

function requestedEvent(row: ToolCallRow, denialReason: string | null, injectionSignals: string) {
  const base = { callId: row.id, toolId: row.tool_id, toolVersion: row.tool_version, riskClass: row.risk_class, externalEffect: row.external_effect, ...(injectionSignals === '' ? {} : { injectionSignals }) };
  return denialReason === null ? toolCallRequested(base) : toolCallRequested({ ...base, denialReason });
}

/** The DISTINCT signals across every untrusted item, comma-joined. Signals only — the content never leaves memory. */
function injectionSignalsIn(context: readonly unknown[]): string {
  const found = new Set<string>();
  for (const item of context) {
    const content = (item as { content?: unknown } | null | undefined)?.content;
    if (typeof content === 'string') for (const s of detectInjection(content).signals) found.add(s);
  }
  return [...found].sort().join(',');
}

function completedEvent(row: ToolCallRow) {
  return toolCallCompleted({ callId: row.id, toolId: row.tool_id, riskClass: row.risk_class, callOutcome: row.outcome, hasReceipt: row.receipt_ref !== null });
}

function auditCtx(options: DispatcherOptions): AuditWriteContext {
  return options.correlationId !== undefined ? { correlationId: options.correlationId } : {};
}
function opts(options: DispatcherOptions): { correlationId?: string; logger?: Logger } {
  const o: { correlationId?: string; logger?: Logger } = {};
  if (options.correlationId !== undefined) o.correlationId = options.correlationId;
  if (options.logger !== undefined) o.logger = options.logger;
  return o;
}
