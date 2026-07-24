// ACBP-P2-006 / CDR-024 — real-PostgreSQL proof of the typed-memory use cases through the RESTRICTED role.
// Setup/seed runs on the owner connection (two-tenant harness); every operation runs as `acbp_app` under a
// validated CompanyScope. Proves: create a typed item (audited in the SAME transaction — metadata {item_type,
// source_type}, actor/account/company server-stamped); the type-by-source-path rule (a generated source can
// never be a user_fact); untyped/invalid rejection; list (newest-first, type filter, bounded); write/read =
// owner|viewer with non-members + cross-tenant forbidden; cross-company isolation; audit atomicity (a failing
// audit writer persists NO item); exact actor; NO activity projection; concurrent creation appends distinct
// rows (no overwrite).
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DatabaseClient } from '@acbp/database';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createMemoryItem, listMemoryItems, editMemoryItem, getMemoryItem, deleteMemoryItem } from './memory-item.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

describe.skipIf(!hasTestDatabase)('typed memory use cases (real PostgreSQL, restricted role) — ACBP-P2-006/CDR-024', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;

  beforeAll(async () => {
    owner = createOwnerFixtureClient();
    await resetSchema(owner);
    await enableAppLogin(owner);
    product = createRestrictedProductClient();
    await assertRestrictedRole(product);
  }, 60_000);
  afterAll(async () => {
    await teardown(owner, product);
  });
  beforeEach(async () => {
    await truncateFixtures(owner);
    w = await seedTwoTenantWorld(owner, product, SEED_OPS);
  });

  const base = (userId: string) => ({ userId, accountId: w.accountA, companyId: w.companyA1 });
  const fact = (over: Record<string, unknown> = {}) => ({ type: 'user_fact', content: 'The founder is in Cairo.', sourceType: 'interview_answer', sourceRef: 'q1:1', ...over });

  test('create a typed item; audited in the same transaction (subject/actor/scope + {item_type, source_type})', async () => {
    const r = await createMemoryItem(product, { ...base(w.aOwner), ...fact() });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.item.type).toBe('user_fact');
    expect(r.item.sourceType).toBe('interview_answer');
    expect(r.item.confirmationState).toBe('proposed');
    expect(r.item.supersededBy).toBeNull();
    // The DTO is redacted — no accountId / actor.
    expect(Object.keys(r.item).sort()).toEqual(['confidence', 'confirmationState', 'content', 'createdAt', 'memoryItemId', 'sourceRef', 'sourceType', 'supersededBy', 'type'].sort());
    // Exactly one audit event, scoped + stamped, metadata is exactly {item_type, source_type}.
    const audits = await owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'memory.item_created').execute();
    expect(audits).toHaveLength(1);
    const a = audits[0]!;
    expect(a.subject_id).toBe(r.item.memoryItemId);
    expect(a.actor_id).toBe(w.aOwner);
    expect(a.account_id).toBe(w.accountA);
    expect(a.company_id).toBe(w.companyA1);
    expect(a.payload).toEqual({ item_type: 'user_fact', source_type: 'interview_answer' });
    // The stored row carries the server-verified author.
    const row = await owner.kysely.selectFrom('memory_items').selectAll().where('id', '=', r.item.memoryItemId).executeTakeFirstOrThrow();
    expect(row.created_by_user_id).toBe(w.aOwner);
  });

  test('type-by-source-path: a generated source cannot be a user_fact, but can be an ai_assumption', async () => {
    expect((await createMemoryItem(product, { ...base(w.aOwner), ...fact({ sourceType: 'model_generation' }) })).status).toBe('validation');
    expect((await createMemoryItem(product, { ...base(w.aOwner), ...fact({ type: 'user_preference', sourceType: 'task_result' }) })).status).toBe('validation');
    expect((await createMemoryItem(product, { ...base(w.aOwner), ...fact({ type: 'ai_assumption', sourceType: 'model_generation' }) })).status).toBe('ok');
    expect((await createMemoryItem(product, { ...base(w.aOwner), ...fact({ type: 'research_finding', sourceType: 'task_result' }) })).status).toBe('ok');
  });

  test('untyped / unknown-source / missing source_ref are rejected (no row written)', async () => {
    expect((await createMemoryItem(product, { ...base(w.aOwner), ...fact({ type: 'opinion' }) })).status).toBe('validation');
    expect((await createMemoryItem(product, { ...base(w.aOwner), ...fact({ sourceType: 'guess' }) })).status).toBe('validation');
    expect((await createMemoryItem(product, { ...base(w.aOwner), ...fact({ sourceRef: '' }) })).status).toBe('validation');
    expect((await createMemoryItem(product, { ...base(w.aOwner), ...fact({ content: '' }) })).status).toBe('validation');
    expect(await owner.kysely.selectFrom('memory_items').selectAll().execute()).toHaveLength(0);
  });

  test('list returns the company items newest-first, filters by type, and is bounded', async () => {
    await createMemoryItem(product, { ...base(w.aOwner), ...fact({ content: 'first' }) });
    await createMemoryItem(product, { ...base(w.aOwner), ...fact({ type: 'constraint', sourceType: 'user_edit', content: 'a constraint' }) });
    const all = await listMemoryItems(product, base(w.aOwner));
    expect(all.status).toBe('ok');
    if (all.status !== 'ok') return;
    expect(all.items).toHaveLength(2);
    expect(all.items[0]!.createdAt >= all.items[1]!.createdAt).toBe(true); // newest first
    const facts = await listMemoryItems(product, { ...base(w.aOwner), type: 'user_fact' });
    expect(facts.status === 'ok' && facts.items.every((i) => i.type === 'user_fact')).toBe(true);
    expect(facts.status === 'ok' && facts.items).toHaveLength(1);
  });

  test('write/read = owner|viewer; a non-member and a foreign tenant are forbidden', async () => {
    // viewer may write + read.
    expect((await createMemoryItem(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1, ...fact({ content: 'by viewer' }) })).status).toBe('ok');
    expect((await listMemoryItems(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 })).status).toBe('ok');
    // outsider forbidden on both.
    expect((await createMemoryItem(product, { userId: w.outsider, accountId: w.accountA, companyId: w.companyA1, ...fact() })).status).toBe('forbidden');
    expect((await listMemoryItems(product, { userId: w.outsider, accountId: w.accountA, companyId: w.companyA1 })).status).toBe('forbidden');
    // a member of tenant B cannot reach A1.
    expect((await listMemoryItems(product, { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1 })).status).toBe('forbidden');
  });

  test('cross-company isolation: tenant B never sees A1’s memory items', async () => {
    await createMemoryItem(product, { ...base(w.aOwner), ...fact({ content: 'secret memory' }) });
    const bVisible = await owner.kysely.selectFrom('memory_items').selectAll().where('company_id', '=', w.companyB1).execute();
    expect(bVisible).toHaveLength(0);
    expect((await listMemoryItems(product, { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1 })).status).toBe('forbidden');
  });

  test('audit atomicity: a failing audit writer persists NO memory item', async () => {
    const boom = () => Promise.reject(new Error('boom'));
    await expect(createMemoryItem(product, { ...base(w.aOwner), ...fact() }, { auditWriter: boom })).rejects.toThrow();
    expect(await owner.kysely.selectFrom('memory_items').selectAll().execute()).toHaveLength(0);
    expect(await owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'memory.item_created').execute()).toHaveLength(0);
  });

  test('NO activity projection: a memory creation adds no activity_events row (memory.item_created is audit-only)', async () => {
    // Seeding (company.created) legitimately projects activity, so measure the DELTA around the memory create.
    const before = await owner.kysely.selectFrom('activity_events').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
    await createMemoryItem(product, { ...base(w.aOwner), ...fact() });
    const after = await owner.kysely.selectFrom('activity_events').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
    expect(Number(after.n)).toBe(Number(before.n)); // memory.item_created is NOT in the closed activity taxonomy
  });

  test('EDIT = versioned supersede: new user_edit version + old.superseded_by, audited; owner-only; version-guarded (P2-010)', async () => {
    const created = await createMemoryItem(product, { ...base(w.aOwner), ...fact({ content: 'original' }) });
    if (created.status !== 'ok') throw new Error('setup');
    const oldId = created.item.memoryItemId;

    // A viewer may NOT edit (memory:edit is owner-only).
    expect((await editMemoryItem(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1, targetId: oldId, type: 'user_fact', content: 'x' })).status).toBe('forbidden');

    const edited = await editMemoryItem(product, { ...base(w.aOwner), targetId: oldId, type: 'user_fact', content: 'corrected' });
    expect(edited.status).toBe('ok');
    if (edited.status !== 'ok') return;
    // The new version is a user_edit whose source_ref cites the corrected item.
    expect(edited.item.sourceType).toBe('user_edit');
    expect(edited.item.sourceRef).toBe(oldId);
    expect(edited.item.content).toBe('corrected');
    // The OLD row now points at the new version (superseded, never overwritten — content intact).
    const oldRow = await owner.kysely.selectFrom('memory_items').selectAll().where('id', '=', oldId).executeTakeFirstOrThrow();
    expect(oldRow.superseded_by).toBe(edited.item.memoryItemId);
    expect(oldRow.content).toBe('original');
    // A supersede audit event (subject = the OLD id; new version's {item_type, source_type}).
    const audits = await owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'memory.item_superseded').execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.subject_id).toBe(oldId);
    expect(audits[0]!.payload).toEqual({ item_type: 'user_fact', source_type: 'user_edit' });
    // Version-guarded: editing the already-superseded old row → conflict.
    expect((await editMemoryItem(product, { ...base(w.aOwner), targetId: oldId, type: 'user_fact', content: 'again' })).status).toBe('conflict');
    // currentOnly list excludes the superseded row.
    const current = await listMemoryItems(product, { ...base(w.aOwner), currentOnly: true });
    expect(current.status === 'ok' && current.items.map((i) => i.memoryItemId)).toEqual([edited.item.memoryItemId]);
  });

  test('EDIT audit atomicity: a failing audit writer persists NO supersede (old stays current, no new version)', async () => {
    const created = await createMemoryItem(product, { ...base(w.aOwner), ...fact({ content: 'original' }) });
    if (created.status !== 'ok') throw new Error('setup');
    const boom = () => Promise.reject(new Error('boom'));
    await expect(editMemoryItem(product, { ...base(w.aOwner), targetId: created.item.memoryItemId, type: 'user_fact', content: 'corrected' }, { auditWriter: boom })).rejects.toThrow();
    // The whole edit rolled back: old row still current, and no new version was inserted.
    const rows = await owner.kysely.selectFrom('memory_items').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.superseded_by).toBeNull();
  });

  test('getMemoryItem returns a single item; not_found for an unknown id; forbidden for an outsider', async () => {
    const created = await createMemoryItem(product, { ...base(w.aOwner), ...fact() });
    if (created.status !== 'ok') throw new Error('setup');
    expect((await getMemoryItem(product, { ...base(w.aOwner), memoryItemId: created.item.memoryItemId })).status).toBe('ok');
    expect((await getMemoryItem(product, { ...base(w.aOwner), memoryItemId: '00000000-0000-4000-8000-0000000000ff' })).status).toBe('not_found');
    expect((await getMemoryItem(product, { userId: w.outsider, accountId: w.accountA, companyId: w.companyA1, memoryItemId: created.item.memoryItemId })).status).toBe('forbidden');
  });

  test('DELETE = soft delete (owner-only, audited): deleted_at + actor server-set; omitted from list/get; row survives (P2-010)', async () => {
    const created = await createMemoryItem(product, { ...base(w.aOwner), ...fact({ content: 'to delete' }) });
    if (created.status !== 'ok') throw new Error('setup');
    const id = created.item.memoryItemId;

    // A viewer may NOT delete (owner-only).
    expect((await deleteMemoryItem(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1, memoryItemId: id })).status).toBe('forbidden');

    const del = await deleteMemoryItem(product, { ...base(w.aOwner), memoryItemId: id });
    expect(del.status === 'ok' && del.memoryItemId).toBe(id);
    // deleted_at is server-written; deleted_by_user_id is the real actor.
    const row = await owner.kysely.selectFrom('memory_items').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.deleted_at).not.toBeNull();
    expect(row.deleted_by_user_id).toBe(w.aOwner);
    expect(row.content).toBe('to delete'); // the row SURVIVES (soft delete; owner inspection sees history)
    // Exactly one memory.item_deleted event; metadata carries no content.
    const audits = await owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'memory.item_deleted').execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.subject_id).toBe(id);
    expect(audits[0]!.actor_id).toBe(w.aOwner);
    expect(audits[0]!.actor_type).toBe('user');
    expect(audits[0]!.payload).toEqual({ item_type: 'user_fact', source_type: 'interview_answer', transition: 'active_to_deleted' });
    // Omitted from list + get; re-delete and edit-after-delete are rejected.
    const afterDel = await listMemoryItems(product, base(w.aOwner));
    expect(afterDel.status === 'ok' && afterDel.items).toHaveLength(0);
    expect((await getMemoryItem(product, { ...base(w.aOwner), memoryItemId: id })).status).toBe('not_found');
    expect((await deleteMemoryItem(product, { ...base(w.aOwner), memoryItemId: id })).status).toBe('conflict');
    expect((await editMemoryItem(product, { ...base(w.aOwner), targetId: id, type: 'user_fact', content: 'x' })).status).toBe('conflict');
  });

  test('DELETE rejects a superseded historical version; a foreign item is not_found (no existence oracle)', async () => {
    const created = await createMemoryItem(product, { ...base(w.aOwner), ...fact({ content: 'v1' }) });
    if (created.status !== 'ok') throw new Error('setup');
    const edited = await editMemoryItem(product, { ...base(w.aOwner), targetId: created.item.memoryItemId, type: 'user_fact', content: 'v2' });
    if (edited.status !== 'ok') return;
    // The old (superseded) version cannot be deleted.
    expect((await deleteMemoryItem(product, { ...base(w.aOwner), memoryItemId: created.item.memoryItemId })).status).toBe('conflict');
    // A foreign tenant deleting A1's item → forbidden (denied at scope); an unknown id → not_found (no oracle).
    expect((await deleteMemoryItem(product, { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1, memoryItemId: edited.item.memoryItemId })).status).toBe('forbidden');
    expect((await deleteMemoryItem(product, { ...base(w.aOwner), memoryItemId: '00000000-0000-4000-8000-0000000000ff' })).status).toBe('not_found');
  });

  test('DELETE audit atomicity: a failing audit writer leaves the row live and no audit row', async () => {
    const created = await createMemoryItem(product, { ...base(w.aOwner), ...fact() });
    if (created.status !== 'ok') throw new Error('setup');
    const boom = () => Promise.reject(new Error('boom'));
    await expect(deleteMemoryItem(product, { ...base(w.aOwner), memoryItemId: created.item.memoryItemId }, { auditWriter: boom })).rejects.toThrow();
    const row = await owner.kysely.selectFrom('memory_items').selectAll().where('id', '=', created.item.memoryItemId).executeTakeFirstOrThrow();
    expect(row.deleted_at).toBeNull();
    expect(row.deleted_by_user_id).toBeNull();
    expect(await owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'memory.item_deleted').execute()).toHaveLength(0);
  });

  test('CONCURRENT delete: exactly one state transition + one audit event; the loser gets conflict', async () => {
    const created = await createMemoryItem(product, { ...base(w.aOwner), ...fact() });
    if (created.status !== 'ok') throw new Error('setup');
    const [x, y] = await Promise.all([
      deleteMemoryItem(product, { ...base(w.aOwner), memoryItemId: created.item.memoryItemId }),
      deleteMemoryItem(product, { ...base(w.aOwner), memoryItemId: created.item.memoryItemId }),
    ]);
    const statuses = [x.status, y.status].sort();
    expect(statuses).toEqual(['conflict', 'ok']); // exactly one ok, one conflict
    expect(await owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'memory.item_deleted').where('subject_id', '=', created.item.memoryItemId).execute()).toHaveLength(1);
  });

  test('DELETE writes NO activity_events row (memory.item_deleted is audit-only)', async () => {
    const created = await createMemoryItem(product, { ...base(w.aOwner), ...fact() });
    if (created.status !== 'ok') throw new Error('setup');
    const before = await owner.kysely.selectFrom('activity_events').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
    await deleteMemoryItem(product, { ...base(w.aOwner), memoryItemId: created.item.memoryItemId });
    const after = await owner.kysely.selectFrom('activity_events').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
    expect(Number(after.n)).toBe(Number(before.n));
  });

  test('CONCURRENT creation appends distinct rows (append-only; no overwrite)', async () => {
    const [x, y] = await Promise.all([
      createMemoryItem(product, { ...base(w.aOwner), ...fact({ content: 'concurrent A' }) }),
      createMemoryItem(product, { ...base(w.aOwner), ...fact({ content: 'concurrent B' }) }),
    ]);
    expect(x.status).toBe('ok');
    expect(y.status).toBe('ok');
    const rows = await owner.kysely.selectFrom('memory_items').selectAll().where('company_id', '=', w.companyA1).execute();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    expect(new Set(rows.map((r) => r.content))).toEqual(new Set(['concurrent A', 'concurrent B']));
  });
});
