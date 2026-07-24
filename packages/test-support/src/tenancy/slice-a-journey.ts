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
  const mapped = await deps.owner.kysely.selectFrom('users').select(['id', 'status']).where('id', '=', deps.actorUserId).executeTakeFirst();
  record('internal user mapping resolved', 'ACC-002', mapped?.status === 'active', `users row status=${mapped?.status ?? 'missing'} (provider identity → internal id)`);

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

  // ── 6. LIVE DENIAL: the same routes, a foreign tenant's ids (NFR-001) ──────────────────────────────
  const deniedDetail = await deps.routes.companyGet(new Request(`https://app.test/api/companies/${deps.foreignCompanyId}`), { params: Promise.resolve({ companyId: deps.foreignCompanyId }) });
  const deniedText = await deniedDetail.text();
  const deniedActivity = await deps.routes.activityGet(new Request(`https://app.test/api/companies/${deps.foreignCompanyId}/activity`), { params: Promise.resolve({ companyId: deps.foreignCompanyId }) });
  const deniedActivityText = await deniedActivity.text();
  const bothDenied = [deniedDetail.status, deniedActivity.status].every((s) => s === 403 || s === 404);
  const noForeignContent = ![deniedText, deniedActivityText].some((t) => t.includes(deps.foreignCompanyName) || t.includes(deps.foreignAccountId));
  record(
    'LIVE DENIAL: another tenant’s company is refused on the same routes',
    'NFR-001',
    bothDenied && noForeignContent,
    `detail → ${String(deniedDetail.status)}, activity → ${String(deniedActivity.status)}; foreign content in either body=${String(!noForeignContent)}`,
  );

  // ── 7. Full trail verified ────────────────────────────────────────────────────────────────────────
  const audits = await deps.owner.kysely.selectFrom('audit_events').select(['name', 'account_id', 'company_id']).where('company_id', '=', companyId).execute();
  const hasCreatedAudit = audits.some((a) => a.name === 'company.created');
  const auditTenantCorrect = audits.every((a) => a.account_id === account?.account_id);
  record('audit trail: company.created recorded under the caller’s own tenant', 'NFR-001', hasCreatedAudit && auditTenantCorrect, `${String(audits.length)} audit row(s) for the company; all correctly tenant-stamped=${String(auditTenantCorrect)}`);

  const activity = await deps.owner.kysely.selectFrom('activity_events').select(['activity_type', 'company_id']).where('company_id', '=', companyId).execute();
  const taxonomyClosed = activity.every((a) => ['company.created', 'company.updated', 'company.paused', 'company.resumed'].includes(a.activity_type));
  record('activity feed: only the four lifecycle events, scoped to the company', 'NFR-001', activity.length > 0 && taxonomyClosed, `${String(activity.length)} activity row(s); taxonomy closed=${String(taxonomyClosed)}`);

  const foreignTrail = await deps.owner.kysely.selectFrom('audit_events').select('event_id').where('company_id', '=', companyId).where('account_id', '=', deps.foreignAccountId).execute();
  record('no trail attributed to the other tenant', 'NFR-001', foreignTrail.length === 0, `${String(foreignTrail.length)} row(s) cross-attributed (must be 0)`);

  return { steps, companyId };
}
