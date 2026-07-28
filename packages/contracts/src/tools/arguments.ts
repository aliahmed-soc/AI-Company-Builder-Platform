// @acbp/contracts — canonical encoding of tool-call arguments (ACBP-P5-003b; CDR-054; TOOL-002). Zero-dep and PURE.
//
// TOOL-002 records an *arguments digest*, never the arguments. A digest is only useful if it is STABLE — the same
// call must encode identically every time, or duplicate suppression and replay checks both stop working — and if
// DISTINCT calls encode distinctly, or two different requests share one record.
//
// THIS FUNCTION IS TOTAL ON PURPOSE. An earlier shape threw on values JSON cannot represent, which would have created
// the one thing this table must not have: a request that reaches the dispatcher and leaves NO record. The digest's
// job is identity, not validation — a tool's own input schema is what rejects malformed arguments — so unrepresentable
// values are encoded as typed tokens instead. `NaN` and `undefined` stay distinguishable rather than both collapsing
// to `null`, which is what `JSON.stringify` would have done silently.

/** Object keys are sorted so that `{a,b}` and `{b,a}` — the same call — produce the same digest. */
function encode(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      // JSON has no NaN/Infinity, and `JSON.stringify` turns both into `null` — which would make a nonsense argument
      // indistinguishable from a deliberate null.
      return Number.isFinite(value) ? String(value) : `<${String(value)}>`;
    case 'boolean':
      return String(value);
    case 'undefined':
      return '<undefined>';
    case 'bigint':
      return `<bigint:${String(value)}>`;
    case 'function':
      return '<function>';
    case 'symbol':
      return `<symbol:${value.description ?? ''}>`;
    default:
      break;
  }
  const obj: object = value;
  // Terminates on cycles rather than overflowing the stack. Two different cyclic shapes can collide here; that is
  // acceptable for a pathological input, and far better than a request with no record at all.
  if (seen.has(obj)) return '<cycle>';
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return `[${obj.map((v) => encode(v, seen)).join(',')}]`;
    if (obj instanceof Date) return `<date:${Number.isFinite(obj.getTime()) ? obj.toISOString() : 'invalid'}>`;
    const entries = Object.keys(obj as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${encode((obj as Record<string, unknown>)[k], seen)}`);
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

/**
 * A stable, total string encoding of a tool call's arguments. Feed this to sha256 to get TOOL-002's digest.
 *
 * Array order is PRESERVED (it is meaningful); object key order is NOT (it is not).
 */
export function canonicalizeToolArguments(args: unknown): string {
  return encode(args, new Set<object>());
}
