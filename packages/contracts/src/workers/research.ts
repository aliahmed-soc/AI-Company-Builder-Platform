// @acbp/contracts — the research worker's output contract (ACBP-P5-006; CDR-061; WORK-002; NFR-021). Zero-dep, PURE.
//
// WORK-002: *"every claim carries source ref or explicit `unverified` label"*. The backlog states the failure mode
// plainly — **"Source unavailable = unverified label never invention"**.
//
// The output this guards against is not a claim that is WRONG. It is a claim that is plausible and sourced to
// something that does not exist: a founder cannot tell it from a real one, and the product's entire value is that its
// research can be checked. A model asked for citations while lacking sources produces citation-SHAPED strings, so the
// rule has to be structural rather than a request in a prompt.
//
// Four guarantees, in the order they fail:
//   G1  a claim is SOURCED or explicitly UNVERIFIED — there is no third shape, and an empty source list is a refusal;
//   G2  a source must be a source — a real http(s) URL, a non-blank title, a real retrieval timestamp;
//   G6  a source must be something this run ACTUALLY RETRIEVED — the defence against invented and injected citations;
//   G3  one bad claim fails the WHOLE document.

/** The three task types `AI-AND-WORKER-ARCHITECTURE.md:37` names for this worker. Closed. */
export const RESEARCH_TASK_TYPES = ['market_research', 'competitor_research', 'customer_segment_analysis'] as const;
export type ResearchTaskType = (typeof RESEARCH_TASK_TYPES)[number];
export function isResearchTaskType(value: unknown): value is ResearchTaskType {
  return typeof value === 'string' && (RESEARCH_TASK_TYPES as readonly string[]).includes(value);
}

/** Bound on claims per document. A research document with more than this is a dump, not a finding. */
export const MAX_RESEARCH_CLAIMS = 100;

/** The gateway output-schema ref for a research document (the composition dispatches `validateOutput` on it). */
export const RESEARCH_DOCUMENT_SCHEMA = 'research.document.output@1';

/**
 * One source the worker RETRIEVED — the raw material, before any model sees it.
 *
 * `content` is UNTRUSTED EXTERNAL CONTENT (`AI-AND-WORKER-ARCHITECTURE.md` §4). It is wrapped with provenance and
 * treated as data before it reaches a prompt, and any instructions inside it are inert: canon's invariant 17 is that
 * tool calls originate from worker control flow, never from instructions parsed out of processed content.
 */
export interface FetchedSource {
  readonly url: string;
  readonly title: string;
  readonly retrievedAt: string;
  readonly content: string;
}

/**
 * The read-only research fetch port (`web_research`, informational class).
 *
 * PROVIDER-NEUTRAL and deliberately tiny. A CONCRETE implementation reaches the public internet, which is a live
 * external resource and therefore an owner gate (`CDR-061 §3`) — so what ships is this port plus an in-memory
 * implementation, exactly as `FakeModelProvider` and P5-011's storage did.
 */
export interface ResearchFetcher {
  fetch(query: string, options?: { readonly limit?: number }): Promise<readonly FetchedSource[]>;
}

/**
 * One citation. `retrievedAt` is REQUIRED because a citation with no retrieval time cannot be re-checked — the web
 * changes, and "this said X when we read it" is the claim being made.
 */
export interface ResearchSource {
  readonly url: string;
  readonly title: string;
  readonly retrievedAt: string;
}

/**
 * One claim, in exactly one of the two shapes WORK-002 permits.
 *
 * A CLOSED union. Adding a third shape has to be a deliberate edit here, reviewed as such — it cannot arrive as an
 * empty array flowing through a lenient reader.
 */
export type ResearchClaim = { readonly statement: string; readonly sources: readonly ResearchSource[] } | { readonly statement: string; readonly unverifiedReason: string };

/**
 * A shape-valid document that has NOT yet been checked against what the run retrieved (G1 + G2 only, not G6).
 *
 * This type exists because of WHERE the two halves of validation can run. The model gateway's `validateOutput` hook
 * receives `(schemaRef, rawOutput)` and nothing else — it cannot know which URLs this particular run fetched, so it
 * can only check shape. If shape-checking produced a `ResearchDocument`, the retrieval check would become a step a
 * caller must REMEMBER, and "a guard written but never applied" is the defect this repo has hit most often.
 *
 * So a draft is not a document. `certifyResearchDocument` is the only thing that mints one, and it is the only place
 * G6 is enforced — making the central defence unskippable rather than merely documented.
 */
export interface ResearchDraft {
  readonly title: string;
  readonly summary: string;
  readonly claims: readonly ResearchClaim[];
}

declare const researchCertifiedBrand: unique symbol;

/** A research document whose every source was checked against what the run actually retrieved. Only `certifyResearchDocument` mints one. */
export interface ResearchDocument extends ResearchDraft {
  readonly [researchCertifiedBrand]: true;
}

export type ResearchRefusal = 'invalid_document' | 'no_claims' | 'too_many_claims' | 'blank_statement' | 'unsupported_claim' | 'invalid_source' | 'unretrieved_source';

export type ResearchParse =
  | { readonly ok: true; readonly document: ResearchDocument }
  | { readonly ok: false; readonly reason: ResearchRefusal; readonly claimIndex: number | null };

export type ResearchShapeParse =
  | { readonly ok: true; readonly draft: ResearchDraft }
  | { readonly ok: false; readonly reason: ResearchRefusal; readonly claimIndex: number | null };

export type ResearchValidation =
  | { readonly ok: true; readonly sourcedClaims: number; readonly unverifiedClaims: number }
  | { readonly ok: false; readonly reason: ResearchRefusal; readonly claimIndex: number | null };

function present(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * An http(s) URL, parsed BY HAND.
 *
 * `@acbp/contracts` is zero-dependency and carries no Node or DOM typings, so the global `URL` is not available here
 * and pulling in a lib for it would widen the package's contract for one function. The grammar this accepts is
 * deliberately narrow — scheme, authority, path, optional query, optional fragment, and no whitespace anywhere —
 * because a source URL only ever needs to be an ordinary web address.
 *
 * `javascript:` and `ftp:` are not sources; they are other things wearing the shape of one. Requiring `//` after the
 * scheme is what excludes the opaque-scheme family as a class rather than one member at a time.
 */
const HTTP_URL_RE = /^(https?):\/\/([^/?#\s]+)([^?#\s]*)(\?[^#\s]*)?(#\S*)?$/i;
function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && HTTP_URL_RE.test(value);
}

/** A real instant. `'yesterday'` and `'2026-13-45'` are not retrieval times. */
function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value));
}

/**
 * Normalize a URL for the retrieved-set comparison.
 *
 * Compared by ORIGIN + PATH, deliberately: a fragment (`#section-3`) or a differing trailing slash is the same
 * document, while a different query string may genuinely be a different page and is therefore kept. Being too strict
 * here would make honest citations fail; being too loose would let `https://real.example/x?redirect=attacker` count as
 * a retrieval of `https://real.example/x`.
 */
function canonicalUrl(value: string): string | undefined {
  const match = HTTP_URL_RE.exec(value);
  if (match === null) return undefined;
  const scheme = (match[1] ?? '').toLowerCase();
  // Scheme and host are case-insensitive per RFC 3986; the PATH is not, and lowercasing it would make two genuinely
  // different documents compare equal.
  const authority = (match[2] ?? '').toLowerCase();
  const rawPath = match[3] ?? '';
  const path = rawPath.endsWith('/') && rawPath !== '/' ? rawPath.slice(0, -1) : rawPath;
  const query = match[4] ?? '';
  return `${scheme}://${authority}${path}${query}`;
}

function retrievedSet(retrievedUrls: readonly string[]): ReadonlySet<string> {
  const set = new Set<string>();
  for (const url of retrievedUrls ?? []) {
    if (typeof url !== 'string') continue;
    const canonical = canonicalUrl(url);
    if (canonical !== undefined) set.add(canonical);
  }
  return set;
}

const fail = (reason: ResearchRefusal, claimIndex: number | null): { ok: false; reason: ResearchRefusal; claimIndex: number | null } => ({ ok: false, reason, claimIndex });

/**
 * Check one claim against G1, G2 and G6. Returns `null` when the claim is fine.
 *
 * ORDER MATTERS. The statement is checked first (an empty claim is not a claim), then the shape, then each source.
 * Reporting `unsupported_claim` for a claim that is really carrying a malformed source would send a caller looking in
 * the wrong place.
 */
function checkClaim(claim: unknown, index: number, retrieved: ReadonlySet<string> | null): { ok: false; reason: ResearchRefusal; claimIndex: number | null } | null {
  if (typeof claim !== 'object' || claim === null) return fail('unsupported_claim', index);
  const candidate = claim as { statement?: unknown; sources?: unknown; unverifiedReason?: unknown };
  if (!present(candidate.statement)) return fail('blank_statement', index);

  // G1. An explicit `unverified` reason is a complete, first-class answer — and a cheap one, because if admitting
  // ignorance were harder than inventing a source the incentive would run the wrong way (CDR-061 G4).
  if (candidate.sources === undefined) {
    return present(candidate.unverifiedReason) ? null : fail('unsupported_claim', index);
  }
  if (!Array.isArray(candidate.sources)) return fail('unsupported_claim', index);
  // An EMPTY list is a MISSING source, never a declared absence of one. This is the line WORK-002 lives or dies on.
  if (candidate.sources.length === 0) return fail('unsupported_claim', index);

  for (const source of candidate.sources as readonly unknown[]) {
    if (typeof source !== 'object' || source === null) return fail('invalid_source', index);
    const s = source as { url?: unknown; title?: unknown; retrievedAt?: unknown };
    // G2 — citation-shaped text is not a citation.
    if (!isHttpUrl(s.url) || !present(s.title) || !isTimestamp(s.retrievedAt)) return fail('invalid_source', index);
    // G6 — and a perfectly-formed citation to a page this run never fetched is exactly what an invented one looks
    // like, and what injected content asks the model to produce. `null` means "shape pass only"; the certifying pass
    // always supplies a real set, and it is the only path that mints a `ResearchDocument`.
    if (retrieved !== null) {
      const canonical = canonicalUrl(s.url);
      if (canonical === undefined || !retrieved.has(canonical)) return fail('unretrieved_source', index);
    }
  }
  return null;
}

/**
 * Parse and validate a research document against what this run actually retrieved.
 *
 * TOTAL over `unknown` — the input is a model's structured output, and the declared type is only a promise.
 * ALL-OR-NOTHING (G3): one invented citation refuses the whole document, because the valid claims around it would
 * otherwise inherit its credibility.
 */
export function parseResearchOutput(output: unknown, retrievedUrls: readonly string[]): ResearchParse {
  const shape = parseResearchShape(output);
  if (!shape.ok) return shape;
  const certified = certifyResearchDocument(shape.draft, retrievedUrls);
  if (!certified.ok) return certified;
  return { ok: true, document: certified.document };
}

/**
 * G1 + G2 ONLY — shape, not truth. This is what the model gateway's `validateOutput` hook can run, because that hook
 * sees `(schemaRef, rawOutput)` and has no idea which URLs this run fetched.
 *
 * IT RETURNS A DRAFT, NEVER A DOCUMENT. That is the whole point: nothing downstream can persist what comes out of
 * here without going through {@link certifyResearchDocument}, so G6 cannot be forgotten by a caller.
 */
export function parseResearchShape(output: unknown): ResearchShapeParse {
  if (typeof output !== 'object' || output === null) return fail('invalid_document', null);
  const candidate = output as { title?: unknown; summary?: unknown; claims?: unknown };
  if (!present(candidate.title) || !present(candidate.summary)) return fail('invalid_document', null);
  if (!Array.isArray(candidate.claims)) return fail('invalid_document', null);
  if (candidate.claims.length === 0) return fail('no_claims', null);
  if (candidate.claims.length > MAX_RESEARCH_CLAIMS) return fail('too_many_claims', null);

  const claims: ResearchClaim[] = [];
  for (const [index, claim] of (candidate.claims as readonly unknown[]).entries()) {
    // An EMPTY retrieved set here would refuse every sourced claim, so shape-checking passes a set that accepts any
    // well-formed source and leaves the retrieval question entirely to `certifyResearchDocument`.
    const problem = checkClaim(claim, index, null);
    if (problem !== null) return problem;
    const c = claim as { statement: string; sources?: readonly ResearchSource[]; unverifiedReason?: string };
    claims.push(c.sources === undefined ? { statement: c.statement, unverifiedReason: c.unverifiedReason as string } : { statement: c.statement, sources: c.sources });
  }
  return { ok: true, draft: { title: candidate.title, summary: candidate.summary, claims } };
}

/**
 * G6 — the central defence, and the ONLY way to obtain a `ResearchDocument`.
 *
 * Every source must be one this run actually retrieved. A perfectly-formed URL to a real-looking report the worker
 * never fetched is exactly what an invented citation looks like, and exactly what injected content asks a model to
 * produce; shape validation accepts it and only this comparison rejects it.
 */
export function certifyResearchDocument(draft: ResearchDraft, retrievedUrls: readonly string[]): ResearchParse {
  const retrieved = retrievedSet(retrievedUrls);
  for (const [index, claim] of draft.claims.entries()) {
    const problem = checkClaim(claim, index, retrieved);
    if (problem !== null) return problem;
  }
  return { ok: true, document: { title: draft.title, summary: draft.summary, claims: draft.claims } as ResearchDocument };
}

/**
 * Defensively narrow the gateway's ALREADY-VALIDATED output back to a draft.
 *
 * The gateway hands back `unknown` across a seam, and a value that arrived corrupted must not be trusted because
 * something upstream said it validated it. Re-checking the shape costs nothing and is the difference between a typed
 * refusal and a `TypeError` deep in a persist path.
 */
export function narrowResearchDraft(validatedOutput: unknown): ResearchDraft | undefined {
  const parsed = parseResearchShape(validatedOutput);
  return parsed.ok ? parsed.draft : undefined;
}

/**
 * Render a certified document as markdown — the artifact's bytes.
 *
 * EVERY claim renders its evidence inline. A sourced claim carries its links; an unverified one carries the word
 * **Unverified** and the reason. A founder reading the artifact can see which is which without opening anything
 * else, which is the entire point of WORK-002 — the label is worthless if it only exists in the database.
 */
export function renderResearchMarkdown(document: ResearchDocument): string {
  const lines: string[] = [`# ${document.title}`, '', document.summary, '', '## Findings', ''];
  for (const claim of document.claims) {
    lines.push(`- ${claim.statement}`);
    if ('sources' in claim) {
      for (const source of claim.sources) lines.push(`  - Source: [${source.title}](${source.url}) (retrieved ${source.retrievedAt})`);
    } else {
      lines.push(`  - **Unverified.** ${claim.unverifiedReason}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The same gate, applied to an already-parsed document.
 *
 * RE-VERIFIED AT USE, not only at construction — the `verifyKeyBelongsToCompany` precedent. A document can reach a
 * caller from a database row or a retry payload long after it was parsed, and `retrievedUrls` belongs to the run
 * doing the checking, not to whatever run produced it.
 */
export function validateResearchDocument(document: ResearchDocument, retrievedUrls: readonly string[]): ResearchValidation {
  const parsed = parseResearchOutput(document, retrievedUrls);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, claimIndex: parsed.claimIndex };
  let sourcedClaims = 0;
  let unverifiedClaims = 0;
  for (const claim of parsed.document.claims) {
    if ('sources' in claim) sourcedClaims += 1;
    else unverifiedClaims += 1;
  }
  return { ok: true, sourcedClaims, unverifiedClaims };
}
