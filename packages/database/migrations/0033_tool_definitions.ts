// ACBP-P5-003a — the tool registry (CDR-051; TOOL-001; ADR-012). The classification the dispatcher will trust.
//
// GLOBAL, NOT TENANT-SCOPED, and that is deliberate. `DATA-ARCHITECTURE` marks Tool definition `G`: a tool is platform
// configuration, like a model template — not tenant data. So there is no `company_id`, no RLS, and no dual-keyed
// policy, and this table is correctly ABSENT from the tenant-isolation catalog's TENANT_TABLES.
//
// The app role gets SELECT ONLY. There is no runtime write path to the registry at all — exactly the shape
// `platform_admins` has (CDR-019). Registration is an operator action performed by the migration/owner role, which is
// what makes "trust-critical determinations come from the tool registry" (APPROVAL-AND-POLICY-ARCHITECTURE §4) mean
// something: nothing the product runtime can do changes a tool's risk class.
//
// No new SECURITY DEFINER (the closed allowlist stays three), no new role, no policy change to any existing table.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('tool_definitions')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    // The stable tool identity, e.g. `web_research`. Versioned separately below.
    .addColumn('tool_id', 'text', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull())
    // NULLABLE ON PURPOSE (CDR-051 §4). TOOL-001's "unclassified = most restrictive" needs "unclassified" to be a
    // representable state, or the resolution rule has nothing to resolve and the requirement is untestable. The CHECK
    // constrains the value when present; `resolveRiskClass` in @acbp/contracts handles absence.
    .addColumn('risk_class', 'text')
    .addColumn('description', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('active'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    // A tool is REVISED by registering a new version, never by editing a row — "class changes audited"
    // (DATA-ARCHITECTURE). This unique is what makes that structural rather than a convention.
    .addUniqueConstraint('tool_definitions_id_version_uq', ['tool_id', 'version'])
    // Mirrors RISK_CLASSES in @acbp/contracts EXACTLY. A real-PostgreSQL test asserts the two sets agree, so the
    // database and the contract cannot drift — which matters more than usual here, since CDR-051 §0 records that this
    // set is provisional and expected to be revisited.
    .addCheckConstraint('tool_definitions_risk_class_valid', sql`risk_class is null or risk_class in ('informational', 'internal_reversible', 'external_reversible', 'external_irreversible')`)
    .addCheckConstraint('tool_definitions_status_valid', sql`status in ('active', 'retired')`)
    .addCheckConstraint('tool_definitions_tool_id_len', sql`char_length(tool_id) between 1 and 100`)
    .addCheckConstraint('tool_definitions_version_positive', sql`version >= 1`)
    .addCheckConstraint('tool_definitions_description_len', sql`char_length(description) between 1 and 2000`)
    .execute();

  // The dispatcher's lookup: the active definitions for a tool, newest version first.
  await sql`create index tool_definitions_lookup_idx on public.tool_definitions (tool_id, status, version desc)`.execute(db);

  // SELECT ONLY — no INSERT, no UPDATE, no DELETE. The product runtime READS the classification and can never write
  // it, which is the structural half of "a model may suggest a category, but trust-critical determinations come from
  // the registry".
  await sql`grant select on public.tool_definitions to ${APP_ROLE}`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`revoke all on public.tool_definitions from ${APP_ROLE}`.execute(db);
  await sql`drop index if exists public.tool_definitions_lookup_idx`.execute(db);
  await db.schema.dropTable('tool_definitions').ifExists().execute();
}
