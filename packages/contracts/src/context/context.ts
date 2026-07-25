// @acbp/contracts — context-assembly contracts (ACBP-P2-007; CDR-032; AI-AND-WORKER §1; MEM-004; NFR-018/021;
// invariant 12). Provider-neutral shapes + PURE logic for building model context from typed memory:
//   - PROVENANCE RANKING: confirmed user items > accepted assumptions > research findings (AI-AND-WORKER §1);
//   - the SECRET BLOCKLIST: a fail-closed, defense-in-depth redactor so a seeded secret never reaches the prompt
//     (invariant 12 / NFR-018) — the assembler is the last gate before the model.
// Zero-dependency leaf: no provider SDK, no DB, no framework. The core `assembleContext` use case (scoped memory read
// + MEM-004 conflict → question emission + the gateway call) is P2-007's follow-up core slice.
import type { MemoryType, MemoryConfirmationState } from '../memory/memory.js';

/** The provenance tier an item occupies in the assembled prompt (1 = highest authority). `null` = excluded. */
export type ContextTier = 1 | 2 | 3;

/** The minimal typed-memory shape the ranker needs (a structural subset of `MemoryItemDTO`). */
export interface RankableMemoryItem {
  readonly type: MemoryType;
  readonly content: string;
  readonly confidence: number;
  readonly confirmationState: MemoryConfirmationState;
  /** ISO-8601 timestamp (recency tiebreak). */
  readonly createdAt: string;
}

/** The user-stated / founder-authoritative types (MEM-001 type-by-source): tier 1, regardless of confirmation state. */
const TIER1_TYPES: ReadonlySet<MemoryType> = new Set<MemoryType>(['user_fact', 'user_preference', 'constraint', 'approved_decision', 'measured_outcome', 'correction']);

/**
 * The provenance tier of an item, or `null` if it must be EXCLUDED from context. `invalidated` items are never fed to
 * the model (excluded). Otherwise: authoritative user types → 1; `ai_assumption` → 2; `research_finding` → 3.
 */
export function provenanceTier(item: Pick<RankableMemoryItem, 'type' | 'confirmationState'>): ContextTier | null {
  if (item.confirmationState === 'invalidated') return null;
  if (TIER1_TYPES.has(item.type)) return 1;
  if (item.type === 'ai_assumption') return 2;
  return 3; // research_finding (and any future non-authoritative type) ranks lowest
}

/** Confirmation-state ordering within a tier: validated/accepted before proposed (proposed surfaces at the tail). */
function confirmationRank(state: MemoryConfirmationState): number {
  switch (state) {
    case 'validated':
      return 0;
    case 'accepted':
      return 1;
    default:
      return 2; // proposed (invalidated is already excluded upstream)
  }
}

/**
 * Rank typed memory for the prompt (AI-AND-WORKER §1): EXCLUDE invalidated, then order by provenance tier (asc),
 * then confirmation strength, then confidence (desc), then recency (desc). A PURE, stable projection — a confirmed
 * user item always precedes an AI assumption, which always precedes a research finding (MEM-004 precedence ordering).
 */
export function rankMemoryForContext<T extends RankableMemoryItem>(items: readonly T[]): readonly T[] {
  const withTier = items.map((item, index) => ({ item, index, tier: provenanceTier(item) })).filter((e): e is { item: T; index: number; tier: ContextTier } => e.tier !== null);
  withTier.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const ca = confirmationRank(a.item.confirmationState);
    const cb = confirmationRank(b.item.confirmationState);
    if (ca !== cb) return ca - cb;
    if (a.item.confidence !== b.item.confidence) return b.item.confidence - a.item.confidence;
    const ta = Date.parse(a.item.createdAt);
    const tb = Date.parse(b.item.createdAt);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
    return a.index - b.index; // stable
  });
  return withTier.map((e) => e.item);
}

// ── Secret blocklist (invariant 12 / NFR-018) — fail-closed, defense-in-depth ─────────────────────────────

/** The fixed marker a redacted secret span is replaced with (never the raw value). */
export const SECRET_PLACEHOLDER = '[REDACTED_SECRET]';

/**
 * The CLOSED set of secret-shaped patterns redacted before any memory content reaches the model. Conservative,
 * low-false-positive shapes (CDR-032 §2). Each is global; ordering favors structural (PEM, connection strings)
 * before token shapes. The high-entropy catch-all requires mixed lower+upper+digit over ≥40 chars to avoid
 * redacting ordinary business prose.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  // PEM private keys — well-formed BEGIN…END block. The body is BOUNDED (`{0,16384}?`, not `*?`) so a BEGIN with no
  // END fails in O(bound) per start instead of scanning to EOF — no quadratic ReDoS (security review H1).
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]{0,16384}?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  // PEM private keys — fail-CLOSED fallback: a BEGIN header + its base64 body even with NO END sentinel (a truncated
  // or reformatted key). A single bounded quantifier over the base64 charset → linear; the raw key body is never
  // emitted even when the END line is missing (security review H2).
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[A-Za-z0-9+/=\r\n ]{0,16384}/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/gi, // scheme://user:password@host connection strings
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, // JWT (three base64url segments; entropy-independent)
  // `key = value` / `key: value` credential assignments — password/secret/token/api_key/… (a common leak shape the
  // token-prefix patterns miss; security review M1). Requires the keyword + assignment, so false positives are low.
  /\b(?:pass(?:word|wd)?|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*['"]?[^\s'"]{6,}/gi,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\b[rs]k_live_[A-Za-z0-9]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[posru]_[A-Za-z0-9]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, // SendGrid
  /\bnpm_[A-Za-z0-9]{20,}\b/g, // npm token
  /\b(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{40,}\b/g, // high-entropy catch-all
];

/** True IFF the text contains a secret-shaped span (any blocklist pattern matches). */
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => {
    re.lastIndex = 0; // reset global-regex state before test
    return re.test(text);
  });
}

/**
 * Redact every secret-shaped span to {@link SECRET_PLACEHOLDER} (fail-closed: a match is never emitted raw; the
 * placeholder always marks the removal). Idempotent-safe: the placeholder itself contains no secret shape. Applies
 * every pattern in order.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, SECRET_PLACEHOLDER);
  }
  return out;
}
