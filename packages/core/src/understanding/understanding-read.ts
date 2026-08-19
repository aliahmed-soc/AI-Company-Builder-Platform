// @acbp/core — reading the current understanding document (ACBP-API-013; DISC-006/DISC-008; UNDER-001/005).
//
// ⚠️ THIS IS A DOMAIN ADDITION, AND IT WAS AUTHORIZED RATHER THAN ASSUMED. `packages/core/src/understanding/`
// shipped four WRITES (`generateUnderstanding`, `recordUnderstandingReview`, `confirmUnderstanding`,
// `correctUnderstanding`) plus the strategy-unlock gate, and no read that returns the document itself — so
// ACBP-FE-009 could not be built, and the frontend backlog carried it as `Blocked-API`. The identical shape was
// REFUSED earlier on ACBP-API-011 (`listHeldWork`, CDR-094 §3.2) because adding a read core does not have is a
// domain addition rather than exposure. The owner ruled the other way here, explicitly, on 2026-08-19. That
// difference is recorded because the precedent otherwise reads as contradicted.
//
// NOTHING NEW IS INTRODUCED BELOW. The authorization action (`understanding:read`), the repository reads
// (`currentDocument`, `listItems`), the DTO (`UnderstandingDocumentDTO`), the closed class vocabulary and the
// pure section rollup all already existed; this file is the door onto them.
import { computeSections, isConfirmationEventKind, isUnderstandingClass, isVersionConfirmed, isVersionSuperseded, type UnderstandingItemInput } from '@acbp/contracts';
import { UnderstandingRepository, UnderstandingReviewRepository, type DatabaseClient } from '@acbp/database';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import { toDocumentDTO, type UnderstandingDocumentDTO, type UnderstandingItemDTO } from './understanding-generation.js';
import type { UnderstandingReviewOptions } from './understanding-review.js';

export interface ReadUnderstandingParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
}

export type ReadUnderstandingResult =
  | {
      readonly status: 'ok';
      /**
       * The company's CURRENT (highest-version) understanding, or NULL when none has been generated.
       *
       * NULL IS A SUCCESS, NOT A NOT-FOUND — the CDR-087 §5.0 G9 rule this codebase applies to every "latest X"
       * read. The company exists and the caller may read it; the interview simply has not produced an
       * understanding yet, and that is the honest first-visit empty state rather than an error page.
       */
      readonly document: UnderstandingDocumentDTO | null;
      /**
       * Whether THIS version is confirmed — the same predicate the strategy-unlock gate uses
       * (`isCurrentUnderstandingConfirmed`), reading the same events through the same pure function, so the read
       * and the gate can never disagree. False when no document exists.
       */
      readonly confirmed: boolean;
      /**
       * DISC-008: this version WAS confirmed and a correction has since superseded that confirmation.
       *
       * ⚠️ NOT `!confirmed`. The gate answers false for two different states — never confirmed, and
       * confirmed-then-corrected — and ACBP-FE-009 requires the screen to "show a stale document as stale",
       * which it cannot do from a single boolean. Both facts come from the SAME events through the SAME
       * contracts predicates, so they cannot drift apart. False when no document exists.
       */
      readonly superseded: boolean;
    }
  | { readonly status: 'forbidden' };

/**
 * Read the company's current understanding document with its classified items (`understanding:read` → owner +
 * viewer, the same action the generation read and the unlock gate use).
 *
 * ⚠️ **"STALE" MEANS TWO DIFFERENT THINGS HERE. THIS READ REPORTS ONE OF THEM AND DELIBERATELY REFUSES THE OTHER.**
 *
 * 1. REPORTED — DISC-008 supersession (`superseded`): this understanding version was confirmed, and a correction
 *    has since superseded that confirmation. It is folded from the events this function already reads, by the
 *    same `@acbp/contracts` predicate family as the gate, so it cannot disagree with `confirmed`. ACBP-FE-009
 *    requires the screen to "show a stale document as stale", and a lone `confirmed: false` cannot express it —
 *    it says the same thing about a document nobody has confirmed yet.
 *
 * 2. REFUSED — GENERATION staleness: whether some pinned generation is now running against a moved understanding.
 *    That already has an authority. The generate paths refuse with `stale_understanding` by comparing the current
 *    document's id and version against the one the generation pinned (`strategy-generation.ts`). Deriving a
 *    second, independently-computed version of THAT here is the duplicate authority CDR-087 §1 exists to prevent,
 *    and the two would drift the first time either definition changed — with this read's copy being the one no
 *    test of the generate path covers. The enforcement stays where the consequence is.
 *
 * The distinction is worth the paragraph because the two are one word apart in conversation and a long way apart
 * in what they license a screen to claim.
 *
 * SECTIONS ARE RECOMPUTED, NOT STORED. `understanding_documents` persists only `overall_confidence`; the per-class
 * rollup lives in `computeSections`, the same pure contracts function generation used to build the document in the
 * first place. Recomputing from the stored items is what keeps one definition of a section rather than two.
 */
export async function readCurrentUnderstanding(
  client: DatabaseClient,
  params: ReadUnderstandingParams,
  options: UnderstandingReviewOptions = {},
): Promise<ReadUnderstandingResult> {
  const opts = {
    ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  };
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<ReadUnderstandingResult> => {
      if (checkAuthorization(role, 'understanding:read', { accountId: params.accountId, actorId: params.userId }, opts).kind === 'deny') {
        return { status: 'forbidden' };
      }
      const repo = new UnderstandingRepository(scope.db);
      const current = await repo.currentDocument(params.companyId);
      if (current === undefined) return { status: 'ok', document: null, confirmed: false, superseded: false };

      const rows = await repo.listItems(current.id);
      // The DB CHECK (`understanding_items_class_valid`, migration 0019) already closes this vocabulary; the
      // predicate is defence in depth against a row written by some future path that forgets to ask. A row whose
      // class is not in the closed set is DROPPED rather than rendered as an unknown class — showing an
      // uncategorised item beside categorised ones would misreport what the interview actually established.
      const items: UnderstandingItemDTO[] = [];
      const forSections: UnderstandingItemInput[] = [];
      for (const row of rows) {
        if (!isUnderstandingClass(row.item_class)) continue;
        items.push({ class: row.item_class, content: row.content, confidence: row.confidence });
        forSections.push({ class: row.item_class, content: row.content, confidence: row.confidence });
      }

      // Read the events ONCE and fold them twice. Two queries would be two chances for the gate and the stale
      // flag to describe different moments in time.
      const raw = await new UnderstandingReviewRepository(scope.db).listConfirmationEvents(current.id);
      const events = raw.filter((e) => isConfirmationEventKind(e.kind)).map((e) => ({ kind: e.kind as 'confirmed' | 'corrected' }));

      return {
        status: 'ok',
        document: toDocumentDTO(current, computeSections(forSections), items),
        confirmed: isVersionConfirmed(events),
        superseded: isVersionSuperseded(events),
      };
    },
    opts,
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}
