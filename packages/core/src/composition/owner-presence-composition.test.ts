// @acbp/core/composition — the owner-presence gate ON THE PATH THAT MATTERS (AGENTS.md §1, §3).
//
// The provider's own suite proves the gate refuses, consumes one grant per call, and refuses before the SDK is
// touched. That is the MECHANISM. This file asks the second question AGENTS.md §3 now requires: does the
// mechanism actually run where the money would be spent?
//
// It matters because the same repository has recorded four guards that were correct code nothing reached with
// the input that mattered. A gate that a composed runtime silently bypasses is that failure with a bill.
//
// ⚠️ WHAT THESE ASSERTIONS ARE. They read SOURCE. Invoking the composed gateway for real would require a live
// database (the gateway writes usage events before and after a call) and, without the gate, a live network call
// — so a behavioural test here would either need real Postgres or would spend money to prove money is not spent.
// Source assertions are what is honestly checkable at this layer, and their limit is stated rather than implied:
// they prove the production call site passes no grant and that the config forwards one. They do NOT re-prove the
// refusal behaviour — `anthropic-provider.test.ts` does that, behaviourally, and would go red without it.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

function source(file: string): string {
  return readFileSync(join(HERE, file), 'utf8');
}

/**
 * The body of a named function, brace-matched.
 *
 * Not a regex over the whole file: `clerk-identity.ts` is 600+ lines and mentions the gateway in prose in several
 * places, so a file-wide search would answer a different question from the one asked.
 */
function functionBody(src: string, needle: string): string {
  const start = src.indexOf(needle);
  if (start === -1) throw new Error(`fixture: ${needle} not found — this test can no longer see its target`);
  const open = src.indexOf('{', start);
  if (open === -1) throw new Error(`fixture: no body found for ${needle}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`fixture: unbalanced braces after ${needle}`);
}

describe('AGENTS.md §1 — the COMPOSED runtime refuses live calls by default', () => {
  test('the production composition passes NO grant, so the provider default (refusal) stands', () => {
    // This is the call that a deployed application actually makes. If it ever supplied a grant, every metered
    // route would be able to spend without anyone present — which is the exact condition §1 forbids.
    const body = functionBody(source('clerk-identity.ts'), 'function modelGateway()');

    expect(body, 'fixture: this test targets the wrong function').toContain('createAnthropicGateway');
    expect(
      body,
      'the composed runtime now supplies an owner-presence grant — a deployed app could make paid calls unattended',
    ).not.toContain('ownerPresence');
    expect(body).not.toContain('grantLiveCalls');
  });

  test('the gateway FORWARDS a grant when one is given — the config option is not dead', () => {
    // The other half. A composition that accepted `ownerPresence` and dropped it would satisfy the test above
    // while making the option a lie, and the owner-run demo path would silently stop working.
    const body = functionBody(source('anthropic-gateway.ts'), 'export function createAnthropicGateway');

    expect(body).toContain('new AnthropicModelProvider');
    expect(body, 'createAnthropicGateway no longer forwards ownerPresence to the provider').toContain(
      'config.ownerPresence',
    );
  });

  test('the gateway does not invent its own default — refusal has exactly one source', () => {
    // Two places deciding the default is two places that can disagree. The provider owns it; this layer only
    // forwards. `refuseAllLiveCalls` appearing here would mean the answer lives twice.
    const src = source('anthropic-gateway.ts');

    expect(src).not.toContain('refuseAllLiveCalls(');
    expect(src).not.toContain('grantLiveCalls(');
  });
});
