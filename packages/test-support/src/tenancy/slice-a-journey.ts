// ACBP-P1-015 / CDR-021 — the Slice A journey, implemented ONCE and shared by the runnable demo script and
// the CI suite so the two can never drift. Test-support only; never a production dependency.
//
// The journey is the M1 exit criterion: sign in → internal mapping → account → company → switch →
// cross-company access denied, with the audit/activity trail verified. Every step runs through the REAL
// production stack (route handlers → composed runtime → @acbp/core → @acbp/database → restricted acbp_app
// under FORCE RLS); only the provider SDK edge is seamed, and the production authentication boundary still
// executes in full.
//
// The journey does not own its fixtures or its route modules: the caller supplies them, because the demo
// script and the CI suite prepare the environment differently (a script prints and exits; a suite has
// lifecycle hooks). The journey's job is the sequence, the evidence and the verdicts.
import type { DatabaseClient } from '@acbp/database';

/** A step's verdict. `detail` is human-readable evidence for the demo script's transcript. */
export interface JourneyStep {
  readonly step: string;
  readonly requirement: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** The route handlers the journey drives (the REAL modules; supplied by the caller). */
export interface JourneyRoutes {
  readonly companiesGet: (request: Request) => Promise<Response>;
  readonly companiesPost: (request: Request) => Promise<Response>;
  readonly companyGet: (request: Request, context: { params: Promise<{ companyId: string }> }) => Promise<Response>;
  readonly activityGet: (request: Request, context: { params: Promise<{ companyId: string }> }) => Promise<Response>;
}

export interface JourneyDeps {
  /** Authenticate subsequent requests as this internal user id (drives the provider-edge seam). */
  signInAs(internalUserId: string): Promise<void>;
  readonly routes: JourneyRoutes;
  /** Owner/fixture client — evidence inspection only; never used to prove isolation. */
  readonly owner: DatabaseClient;
  /** The journey's protagonist and the unrelated second tenant used for the live denial. */
  readonly actorUserId: string;
  readonly foreignCompanyId: string;
  readonly foreignCompanyName: string;
  readonly foreignAccountId: string;
}

const json = (url: string, body: unknown): Request => new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/**
 * Run the whole Slice A journey. Returns every step's verdict plus the created company id. NEVER throws for
 * a failed step — the caller decides how to report (the script prints and exits non-zero; the suite asserts),
 * so a failure is always visible with its evidence rather than as an opaque stack.
 */
export async function runSliceAJourney(deps: JourneyDeps): Promise<{ readonly steps: readonly JourneyStep[]; readonly companyId: string | null }> {
  const steps: JourneyStep[] = [];
  const record = (step: string, requirement: string, ok: boolean, detail: string): void => {
    steps.push({ step, requirement, ok, detail });
  };

  // ── 1/2. Sign in + internal mapping ───────────────────────────────────────────────────────────────
  await deps.signInAs(deps.actorUserId);
  const portfolioProbe = await deps.routes.companiesGet(new Request('https://app.test/api/companies'));
  record(
    'sign in → verified identity accepted',
    'ACC-001/ACC-002',
    portfolioProbe.status === 200,
    `GET /api/companies → ${String(portfolioProbe.status)} (the production auth boundary ran: session resolved, primary email verified)`,
  );
  // A precondition, not independent evidence: the fixture wrote this row. The step that actually PROVES the
  // provider identity resolved to THIS internal user is the audit check below, which reads the actor id the
  // route itself stamped.
  const mapped = await deps.owner.kysely.selectFrom('users').select(['id', 'status']).where('id', '=', deps.actorUserId).executeTakeFirst();
  record('internal user mapping is active (precondition)', 'ACC-002', mapped?.status === 'active', `users row status=${mapped?.status ?? 'missing'} (provider identity → internal id)`);

  // ── 3. Account bootstrap ──────────────────────────────────────────────────────────────────────────
  const account = await deps.owner.kysely.selectFrom('memberships').select(['account_id', 'role', 'status']).where('member_user_id', '=', deps.actorUserId).where('role', '=', 'owner').executeTakeFirst();
  record('personal account provisioned with an owner membership', 'ACC-002', account?.status === 'active', `owner membership on account ${account?.account_id ?? 'missing'}`);

  // ── 4. Company creation (COMP-001) ────────────────────────────────────────────────────────────────
  const created = await deps.routes.companiesPost(json('https://app.test/api/companies', { creationMode: 'own_idea', name: 'Slice A Co', description: 'created by the Slice A journey' }));
  const createdBody = (await created.json()) as { company?: { companyId?: string; status?: string; creationMode?: string } };
  const companyId = createdBody.company?.companyId ?? null;
  record(
    'company created through the real route',
    'COMP-001',
    created.status === 201 && companyId !== null && createdBody.company?.creationMode === 'own_idea',
    `POST /api/companies → ${String(created.status)}, companyId=${companyId ?? 'none'}, mode=${createdBody.company?.creationMode ?? 'none'}`,
  );
  if (companyId === null) return { steps, companyId: null };

  // ── 5. Switch: the portfolio lists it, and the detail resolves under a fresh scope (PORT-003) ──────
  const portfolio = await deps.routes.companiesGet(new Request('https://app.test/api/companies'));
  const portfolioText = await portfolio.text();
  const portfolioBody = JSON.parse(portfolioText) as { items: { companyId: string; name: string }[] };
  const listsOwn = portfolioBody.items.some((i) => i.companyId === companyId);
  const leaksForeign = portfolioText.includes(deps.foreignCompanyId) || portfolioText.includes(deps.foreignCompanyName);
  record('portfolio lists the new company and nothing foreign', 'PORT-003', listsOwn && !leaksForeign, `${String(portfolioBody.items.length)} item(s); own listed=${String(listsOwn)}; foreign content present=${String(leaksForeign)}`);

  const detail = await deps.routes.companyGet(new Request(`https://app.test/api/companies/${companyId}`), { params: Promise.resolve({ companyId }) });
  const detailBody = (await detail.json()) as { company?: { companyId?: string; name?: string } };
  record('switch into the company resolves its own context', 'PORT-003', detail.status === 200 && detailBody.company?.companyId === companyId && detailBody.company?.name === 'Slice A Co', `GET /api/companies/{id} → ${String(detail.status)}, name=${detailBody.company?.name ?? 'none'}`);

  // A real A→B→A switch inside ONE process, which is what PORT-003 ("context switch discards prior tenant
  // state") actually names. A single GET of the caller's only company cannot detect state carried over from a
  // previous company; alternating between two and re-checking the first can.
  const secondCreated = await deps.routes.companiesPost(json('https://app.test/api/companies', { creationMode: 'existing_business', name: 'Slice A Second Co' }));
  const secondId = ((await secondCreated.json()) as { company?: { companyId?: string } }).company?.companyId ?? null;
  const readName = async (id: string): Promise<string | undefined> => {
    const res = await deps.routes.companyGet(new Request(`https://app.test/api/companies/${id}`), { params: Promise.resolve({ companyId: id }) });
    return ((await res.json()) as { company?: { name?: string } }).company?.name;
  };
  const switched = secondId === null ? [] : [await readName(secondId), await readName(companyId), await readName(secondId)];
  record(
    'switching back and forth never carries the previous company’s context',
    'PORT-003',
    secondId !== null && switched.join('|') === 'Slice A Second Co|Slice A Co|Slice A Second Co',
    `A→B→A resolved: ${switched.map((n) => n ?? 'none').join(' → ') || 'second company not created'}`,
  );

  // ── 6. LIVE DENIAL: the same routes, a foreign tenant's ids (NFR-001) ──────────────────────────────
  const deniedDetail = await deps.routes.companyGet(new Request(`https://app.test/api/companies/${deps.foreignCompanyId}`), { params: Promise.resolve({ companyId: deps.foreignCompanyId }) });
  const deniedText = await deniedDetail.text();
  const deniedActivity = await deps.routes.activityGet(new Request(`https://app.test/api/companies/${deps.foreignCompanyId}/activity`), { params: Promise.resolve({ companyId: deps.foreignCompanyId }) });
  const deniedActivityText = await deniedActivity.text();
  const bothDenied = [deniedDetail.status, deniedActivity.status].every((s) => s === 403 || s === 404);
  const noForeignContent = ![deniedText, deniedActivityText].some((t) => t.includes(deps.foreignCompanyName) || t.includes(deps.foreignAccountId));
  // The envelope must be BOUNDED, not merely free of the two strings this fixture happens to know: a
  // regression that answered 403 with the foreign company's status and timestamps would pass a
  // string-absence check while leaking. `{ error }` and nothing else is the whole permitted shape.
  const bounded = [deniedText, deniedActivityText].every((t) => {
    try {
      return JSON.stringify(Object.keys(JSON.parse(t) as Record<string, unknown>)) === '["error"]';
    } catch {
      return false;
    }
  });
  record(
    'LIVE DENIAL: another tenant’s company is refused on the same routes',
    'NFR-001',
    bothDenied && noForeignContent && bounded,
    `detail → ${String(deniedDetail.status)}, activity → ${String(deniedActivity.status)}; bounded {error} envelope=${String(bounded)}; foreign content in either body=${String(!noForeignContent)}`,
  );

  // ── 7. Full trail verified ────────────────────────────────────────────────────────────────────────
  const audits = await deps.owner.kysely.selectFrom('audit_events').select(['name', 'account_id', 'company_id', 'actor_id']).where('company_id', '=', companyId).execute();
  const hasCreatedAudit = audits.some((a) => a.name === 'company.created');
  const auditTenantCorrect = audits.every((a) => a.account_id === account?.account_id);
  // The actor the ROUTE stamped — this, not the fixture's own users row, is what proves the provider
  // identity was resolved to exactly this internal user (ACC-002) rather than to some other or default one.
  const actorCorrect = audits.every((a) => a.actor_id === deps.actorUserId);
  record(
    'audit trail: company.created recorded under the caller’s own tenant and actor',
    'ACC-002/NFR-001',
    hasCreatedAudit && auditTenantCorrect && actorCorrect,
    `${String(audits.length)} audit row(s); tenant-stamped=${String(auditTenantCorrect)}; every actor_id is the resolved internal user=${String(actorCorrect)}`,
  );

  const activity = await deps.owner.kysely.selectFrom('activity_events').select(['activity_type', 'company_id']).where('company_id', '=', companyId).execute();
  const taxonomyClosed = activity.every((a) => ['company.created', 'company.updated', 'company.paused', 'company.resumed'].includes(a.activity_type));
  record('activity feed: only the four lifecycle events, scoped to the company', 'NFR-001', activity.length > 0 && taxonomyClosed, `${String(activity.length)} activity row(s); taxonomy closed=${String(taxonomyClosed)}`);

  // Falsifiable in the direction that matters: not "own company under the foreign account" (which the
  // company_id filter alone already makes impossible), but "did anything this caller did leave a mark inside
  // the OTHER tenant?". The denied requests above are precisely what would produce such a row.
  const foreignTrail = await deps.owner.kysely.selectFrom('audit_events').select(['event_id', 'name']).where('account_id', '=', deps.foreignAccountId).where('actor_id', '=', deps.actorUserId).execute();
  record('the caller left no trail inside the other tenant, not even from the denials', 'NFR-001', foreignTrail.length === 0, `${String(foreignTrail.length)} row(s) in account ${deps.foreignAccountId} attributed to this caller (must be 0)`);

  return { steps, companyId };
}
