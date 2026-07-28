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

export interface ResearchDocument {
  readonly title: string;
  readonly summary: string;
  readonly claims: readonly ResearchClaim[];
}

export type ResearchRefusal = 'invalid_document' | 'no_claims' | 'too_many_claims' | 'blank_statement' | 'unsupported_claim' | 'invalid_source' | 'unretrieved_source';

export type ResearchParse =
  | { readonly ok: true; readonly document: ResearchDocument }
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
function checkClaim(claim: unknown, index: number, retrieved: ReadonlySet<string>): { ok: false; reason: ResearchRefusal; claimIndex: number | null } | null {
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
    // like, and what injected content asks the model to produce.
    const canonical = canonicalUrl(s.url);
    if (canonical === undefined || !retrieved.has(canonical)) return fail('unretrieved_source', index);
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
  if (typeof output !== 'object' || output === null) return fail('invalid_document', null);
  const candidate = output as { title?: unknown; summary?: unknown; claims?: unknown };
  if (!present(candidate.title) || !present(candidate.summary)) return fail('invalid_document', null);
  if (!Array.isArray(candidate.claims)) return fail('invalid_document', null);
  if (candidate.claims.length === 0) return fail('no_claims', null);
  if (candidate.claims.length > MAX_RESEARCH_CLAIMS) return fail('too_many_claims', null);

  const retrieved = retrievedSet(retrievedUrls);
  const claims: ResearchClaim[] = [];
  for (const [index, claim] of (candidate.claims as readonly unknown[]).entries()) {
    const problem = checkClaim(claim, index, retrieved);
    if (problem !== null) return problem;
    const c = claim as { statement: string; sources?: readonly ResearchSource[]; unverifiedReason?: string };
    claims.push(c.sources === undefined ? { statement: c.statement, unverifiedReason: c.unverifiedReason as string } : { statement: c.statement, sources: c.sources });
  }
  return { ok: true, document: { title: candidate.title, summary: candidate.summary, claims } };
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
