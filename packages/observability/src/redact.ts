// @acbp/observability — recursive, non-mutating redaction (ACBP-P0-017; NFR-018, ADR-014/017).
//
// Redacts secrets before any log emission. Never mutates input; handles circular structures;
// never throws on unusual values. Detects: config `Secret` wrappers, sensitive object keys
// (case-insensitive), sensitive substrings in strings (assignments, Bearer tokens, sensitive
// URL query params, known key formats), and recurses through objects, arrays, and Error causes.
import { Secret } from '@acbp/config';
import { redactSecrets } from '@acbp/contracts';

export const REDACTED = '[REDACTED]';

// Object-key names considered sensitive (matched case-insensitively, allowing separators).
const SENSITIVE_KEY_RE =
  /(password|passwd|secret|token|authorization|cookie|api[-_]?key|client[-_]?secret|private[-_]?key|refresh[-_]?token|access[-_]?token|access[-_]?key|credential|bearer)/i;

// Sensitive assignment inside free text / URL query strings (key=value or key: value).
const SENSITIVE_ASSIGN_RE =
  /([A-Za-z0-9_-]*(?:password|passwd|secret|token|api[-_]?key|client[-_]?secret|private[-_]?key|refresh[-_]?token|access[-_]?token|access[-_]?key|credential|authorization|cookie)[A-Za-z0-9_-]*)(\s*[:=]\s*)("?)([^\s"&]+)(\3)/gi;

function redactString(input: string): string {
  let out = input;
  // Bearer tokens
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`);
  // key=value / key: value assignments where the key is sensitive (covers URL query params too)
  out = out.replace(SENSITIVE_ASSIGN_RE, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`);
  // Known credential formats
  out = out.replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, REDACTED);
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED);
  out = out.replace(/\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g, REDACTED);
  out = out.replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g, REDACTED);
  // ACBP-P7-007 — THE CANONICAL SHAPE LIST, APPLIED LAST so the friendlier forms above win where they match.
  //
  // The rules above are the ORIGINAL P0-017 set, and an independent review measured what they miss: a
  // `scheme://user:password@host` CONNECTION STRING, a JWT, an AWS key id, a Slack token, SendGrid, npm, and the
  // `Basic` authorization scheme all passed through this function verbatim. That mattered here specifically
  // because ACBP-P7-007's own new comment in `logger.ts` offered "a connection string or `password=…`" as
  // interchangeable examples while only the second was handled — a sentence that named a guarantee the code did
  // not provide, which is the defect class this ticket exists to close, committed by the fix for it.
  //
  // `redactSecrets` (contracts `SECRET_PATTERNS`) is a strict superset and was already a dependency of this
  // package, so this is one import rather than a second pattern list to keep in step. It is also the SAME
  // detector `containsSecret` uses, which is what makes the audit sweep and the log redactor agree on what a
  // secret is — before this they did not, and the sweep was the stricter of the two.
  out = redactSecrets(out);
  return out;
}

function redactError(err: Error, seen: WeakSet<object>): Record<string, unknown> {
  const cause = (err as { cause?: unknown }).cause;
  return {
    name: err.name,
    message: redactString(err.message),
    ...(typeof err.stack === 'string' ? { stack: redactString(err.stack) } : {}),
    ...(cause !== undefined ? { cause: redactValue(cause, seen) } : {}),
  };
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  try {
    if (value === null || value === undefined) return value;
    if (value instanceof Secret) return REDACTED;
    const t = typeof value;
    if (t === 'string') return redactString(value as string);
    if (t === 'number' || t === 'boolean' || t === 'bigint') return value;
    if (t === 'symbol' || t === 'function') return `[${t}]`;
    if (value instanceof Error) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
      return redactError(value, seen);
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
      return value.map((v) => redactValue(v, seen));
    }
    if (t === 'object') {
      const obj = value as Record<string, unknown>;
      if (seen.has(obj)) return '[Circular]';
      seen.add(obj);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k] = SENSITIVE_KEY_RE.test(k) ? REDACTED : redactValue(v, seen);
      }
      return out;
    }
    return REDACTED;
  } catch {
    return '[unredactable]';
  }
}

/** Recursively redact a value, returning a NEW structure (input is never mutated). */
export function redact(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}
