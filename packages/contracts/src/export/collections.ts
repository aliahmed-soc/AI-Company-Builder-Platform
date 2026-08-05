// @acbp/contracts — what is IN a founder's archive, and what deliberately is not (ACBP-P7-001; CDR-078 §6;
// EXPORT-001; ADR-002).
//
// ── WHY THIS IS A LIST AND NOT A SET OF FUNCTION CALLS ───────────────────────────────────────────────────────
//
// The largest way this ticket fails its own acceptance criterion — "archive matches in-product data" — is a
// collection nobody remembered to export. A bespoke read per entity could never catch that: the code would be
// correct about everything it mentioned and silent about everything it did not, and the archive would look
// complete to every test written against it.
//
// So the classification is TOTAL and DECLARED. Every table carrying a `company_id` appears in exactly one of the
// two lists below, and `exportCoverage` compares them against the live schema. A table added by a future
// migration is UNCLASSIFIED until someone rules on it, and the guard fails until they do.

/**
 * Why a company-scoped table is NOT in the archive. Closed, because these are RULINGS the owner has to be able to
 * disagree with (CDR-078 §7.3 flags two of them for exactly that), and a ruling has to be a value a reader can
 * enumerate — not a sentence they have to interpret.
 */
export const EXPORT_EXCLUSION_REASONS = [
  /** Another person's identity. A founder's export is not a lawful route to a colleague's account data. */
  'third_party_identity',
  /** Has its OWN export surface with its own authorization and reason capture (API-CONTRACTS `:75`). */
  'separate_export_surface',
  /** Rebuildable from what IS exported. CDR-073's rule: a projection is never a source of truth. */
  'derived_projection',
  /** The platform's own machinery — queues, runs, safety state. Not the founder's work product. */
  'platform_operational',
  /** The platform's books. BILL-* owns them, and they are evidence about the account, not documents. */
  'billing_record',
] as const;
export type ExportExclusionReason = (typeof EXPORT_EXCLUSION_REASONS)[number];

export interface ExportCollection {
  readonly table: string;
  /** Why this is the founder's work. Present so a reader never has to infer the ruling from the table name. */
  readonly note: string;
  /**
   * The columns that put this collection in a DETERMINISTIC order, most significant first.
   *
   * Not decoration. The manifest carries a `sha256` per collection, and without a total order the digest of
   * unchanged data changes between runs — so a founder checking the archive against its own inventory could never
   * distinguish a reordering from a corruption. Declared per table because two of them (`company_profiles`,
   * `interview_answers`) have no `id` column at all, and a blanket `order by created_at` would sort by a
   * non-unique column, which is a shuffle with extra steps.
   */
  readonly orderBy: readonly string[];
}

export interface ExportExclusion {
  readonly table: string;
  readonly reason: ExportExclusionReason;
  readonly note: string;
}

/**
 * The archive's contents, in the order they are read and written.
 *
 * Order is stable and roughly the order the founder produced them — interview, memory, understanding, strategy,
 * decisions, plan, work, documents, governance — so an archive reads as a narrative rather than a table dump.
 */
export const EXPORT_COLLECTIONS: readonly ExportCollection[] = [
  // No `id` column: the profile is keyed by (company_id, version), and company_id is constant under the scope.
  { table: 'company_profiles', note: "The company's own description, written by the founder.", orderBy: ['version'] },
  { table: 'interview_sessions', note: 'The discovery conversations themselves.', orderBy: ['id'] },
  { table: 'interview_questions', note: 'What the platform asked.', orderBy: ['id'] },
  // No `id` column either: an answer is keyed by (question_id, revision), because a founder may revise one.
  { table: 'interview_answers', note: "The founder's own words — the origin of everything downstream.", orderBy: ['question_id', 'revision'] },
  { table: 'memory_items', note: 'Typed memory with provenance: the facts the platform holds about the business.', orderBy: ['id'] },
  { table: 'understanding_documents', note: 'The versioned understanding of the business (DISC-*).', orderBy: ['id'] },
  { table: 'understanding_items', note: 'The individual claims the understanding is made of.', orderBy: ['id'] },
  { table: 'understanding_item_reviews', note: "The founder's per-item review decisions.", orderBy: ['id'] },
  { table: 'understanding_confirmation_events', note: 'When and at what version the founder confirmed.', orderBy: ['id'] },
  { table: 'strategy_generations', note: 'Each round of strategy options, with its provenance.', orderBy: ['id'] },
  { table: 'strategy_options', note: 'The options themselves — the strategic work product.', orderBy: ['id'] },
  { table: 'strategy_recommendations', note: 'What was recommended and why.', orderBy: ['id'] },
  { table: 'strategy_selections', note: 'What the founder chose, edited, combined or rejected.', orderBy: ['id'] },
  { table: 'decisions', note: 'The decision record: the reasoning behind the direction taken.', orderBy: ['id'] },
  { table: 'roadmaps', note: 'The versioned plan (ROAD-*).', orderBy: ['id'] },
  { table: 'goals', note: 'The goals the roadmap is built from.', orderBy: ['id'] },
  { table: 'milestones', note: 'The milestones the work is measured against.', orderBy: ['id'] },
  { table: 'task_review_flags', note: 'Which tasks a roadmap edit put back in question.', orderBy: ['id'] },
  { table: 'planning_runs', note: 'How a plan was produced — the rationale trail (PLAN-004).', orderBy: ['id'] },
  { table: 'planning_run_inputs', note: 'What each planning run actually considered.', orderBy: ['id'] },
  { table: 'tasks', note: 'The work itself.', orderBy: ['id'] },
  { table: 'task_dependencies', note: 'The ordering between tasks — a plan without it is a list.', orderBy: ['id'] },
  { table: 'task_deletions', note: 'What was removed and why, so the plan history stays legible.', orderBy: ['id'] },
  { table: 'artifacts', note: 'Generated documents: metadata and provenance (ADR-016). See the note below on bytes.', orderBy: ['id'] },
  { table: 'artifact_revisions', note: 'The revision history of those documents.', orderBy: ['id'] },
  { table: 'approval_requests', note: 'What the platform asked permission for.', orderBy: ['id'] },
  { table: 'approval_decisions', note: "The founder's own answers — their governance record.", orderBy: ['id'] },
  { table: 'policies', note: "The founder's own rules about what may run unattended.", orderBy: ['id'] },
];

/**
 * Company-scoped tables deliberately NOT in the archive, each with its ruling.
 *
 * Being on this list is a decision, not an oversight — which is the difference this file exists to make visible.
 */
export const EXPORT_EXCLUSIONS: readonly ExportExclusion[] = [
  { table: 'memberships', reason: 'third_party_identity', note: "Account memberships name other people; their identities are not the founder's to take." },
  { table: 'company_memberships', reason: 'third_party_identity', note: 'Same: colleagues on the company, not the founder alone.' },
  { table: 'audit_events', reason: 'separate_export_surface', note: 'Audit has its own owner/admin export with its own reason capture (API-CONTRACTS `:75`).' },
  { table: 'activity_events', reason: 'derived_projection', note: 'A redacted projection of the audit trail; rebuildable, and never a source of truth.' },
  { table: 'policy_evaluations', reason: 'derived_projection', note: 'The evaluation log of `policies`, which IS exported. The rules are the founder’s; the log is machinery.' },
  { table: 'provisioning_steps', reason: 'platform_operational', note: 'How the platform set the workspace up. Says nothing about the business.' },
  { table: 'company_workspace_areas', reason: 'platform_operational', note: 'Platform-internal workspace registry.' },
  { table: 'jobs', reason: 'platform_operational', note: 'Queue state. Transient by construction.' },
  { table: 'job_checkpoints', reason: 'platform_operational', note: 'Resumption bookkeeping for the queue.' },
  { table: 'task_runs', reason: 'platform_operational', note: 'Execution attempts. The OUTPUT (artifacts, task state) is exported; the attempt telemetry is not.' },
  { table: 'tool_calls', reason: 'platform_operational', note: 'Per-call tool telemetry, including receipts the platform owes its own auditors.' },
  { table: 'worker_runs', reason: 'platform_operational', note: 'Worker execution telemetry.' },
  { table: 'company_worker_states', reason: 'platform_operational', note: 'Per-company worker pause state — a control, not a document.' },
  { table: 'emergency_stops', reason: 'platform_operational', note: 'Safety-control state (ADMIN-001).' },
  { table: 'held_work', reason: 'platform_operational', note: 'Work held by a stop, pending review. Operational, and transient by design.' },
  { table: 'usage_events', reason: 'billing_record', note: "The metered ledger behind the account's bill (USAGE-001)." },
  { table: 'credit_transactions', reason: 'billing_record', note: 'The credit ledger (BILL-002).' },
  { table: 'usage_corrections', reason: 'billing_record', note: 'Compensating entries against that ledger (CDR-073).' },
];

const COLLECTION_TABLES: ReadonlySet<string> = new Set(EXPORT_COLLECTIONS.map((c) => c.table));

const ORDER_BY: ReadonlyMap<string, readonly string[]> = new Map(EXPORT_COLLECTIONS.map((c) => [c.table, c.orderBy]));

/** The exported table names, in archive order. */
export function exportCollectionTables(): readonly string[] {
  return EXPORT_COLLECTIONS.map((c) => c.table);
}

/**
 * The declared sort key for an exported table, or `undefined` if the table is not exported.
 *
 * The reader derives ordering from HERE rather than taking it as an argument, so no caller can ask for a different
 * order — and a miss is `undefined` rather than `[]`, so a table that is not exported cannot quietly become an
 * unordered full-table read. ENFORCED BY: "has no sort key for a table it does not export".
 */
export function exportOrderBy(table: string): readonly string[] | undefined {
  return ORDER_BY.get(table);
}

/**
 * Is this an exported table?
 *
 * This predicate is what keeps "generic reader" (CDR-078 §6.1) from meaning "any table the caller names". The
 * check is exact-match against the closed set — no normalisation, no case folding, no trimming — because every
 * one of those would be a way to turn a name that is not in the set into one that is.
 */
export function isExportCollectionTable(value: unknown): boolean {
  return typeof value === 'string' && COLLECTION_TABLES.has(value);
}

/** What the classification and the live schema disagree about. Empty in both directions means they agree. */
export interface ExportCoverage {
  /** Company-scoped in the database, ruled on nowhere. The archive is silently missing these. */
  readonly unclassified: readonly string[];
  /** Classified here, absent from the database. The classification is describing something that no longer exists. */
  readonly stale: readonly string[];
}

function sortedUnique(values: Iterable<string>): readonly string[] {
  return [...new Set(values)].sort();
}

/**
 * Compare the classification against the live set of company-scoped tables (CDR-078 §6-G2).
 *
 * BOTH directions are reported, and reported together: a guard that stops at the first problem turns the second
 * into another CI round-trip.
 *
 * A NON-ARRAY input reports every classified table as stale rather than returning "all clear". The input comes
 * from a schema query, and a query that returned nothing readable must not be indistinguishable from a schema
 * that happens to match — that is a guard failing OPEN, which is the one failure mode a coverage check cannot
 * have. ENFORCED BY: "treats a non-array input as a schema it could not read".
 */
export function exportCoverage(companyScopedTables: readonly string[]): ExportCoverage {
  const classified = [...exportCollectionTables(), ...EXPORT_EXCLUSIONS.map((e) => e.table)];
  if (!Array.isArray(companyScopedTables)) return { unclassified: [], stale: sortedUnique(classified) };
  const live = new Set(companyScopedTables.filter((t): t is string => typeof t === 'string'));
  const known = new Set(classified);
  return {
    unclassified: sortedUnique([...live].filter((t) => !known.has(t))),
    stale: sortedUnique(classified.filter((t) => !live.has(t))),
  };
}
