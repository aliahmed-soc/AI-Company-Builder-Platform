// ACBP-API-006 — ONE real end-to-end generation against the live provider (CDR-091).
//
// This is the script the owner asked for: trigger an actual strategy generation through the real model, not a
// fake, so the OUTPUT can be judged. It is a DEMO, not a test — it is not in the CI gate and never will be,
// because a green pipeline must never depend on spending money.
//
// SAFETY RULES, enforced here rather than left to whoever runs it:
//   * The API key is read from the environment and NEVER printed, echoed, or written to a file.
//   * The model output is printed to STDOUT ONLY. Nothing is written to disk, so nothing can be committed.
//   * It makes exactly ONE call. No loop, no retry — a retry here would be a second real charge, and CDR-091 §3
//     rules that no layer above the gateway may retry.
//
// Run:  node tools/demo/live-generation.mjs
import { AnthropicModelProvider, ANTHROPIC_PROVIDER_NAME } from '@acbp/adapters';
import { Secret } from '@acbp/config';
import { toModelId } from '@acbp/contracts';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (apiKey === undefined || apiKey.trim() === '') {
  console.error('ANTHROPIC_API_KEY is not set. Refusing to run — this script makes a REAL, paid model call.');
  process.exit(1);
}

const modelId = process.env.ANTHROPIC_MODEL_ID ?? 'claude-opus-5';

// A synthetic test company. Deliberately concrete: a vague brief produces vague output and would tell the owner
// nothing about whether the model's actual reasoning is any good.
const COMPANY_BRIEF = `
Company: a two-person startup in Cairo, Egypt.
Idea: a subscription platform for independent gyms — member management, class booking, and QR check-in.
Constraints: members pay cash or bank transfer in person (no card processing in the market they serve).
Founders: one full-stack engineer, one former gym manager. ~6 months of runway. No outside funding.
`.trim();

const PROMPT = `
You are a startup strategy analyst. Given the company below, produce exactly ONE strategic option.

Return it as JSON with these fields and nothing else:
  "name"              - a short label for the strategy
  "target_customer"   - who specifically, not "gyms" in general
  "offer"             - what is sold and how it is priced
  "business_model"    - how money is actually made
  "why_now"           - the specific reason this works now rather than three years ago
  "biggest_risk"      - the single thing most likely to kill it
  "first_90_days"     - the concrete first move

Be specific to THIS company and market. Generic startup advice is a failure.

COMPANY:
${COMPANY_BRIEF}
`.trim();

const provider = new AnthropicModelProvider({ apiKey: new Secret(apiKey) });

console.log(`provider : ${ANTHROPIC_PROVIDER_NAME}`);
console.log(`model    : ${modelId}`);
console.log('making ONE real call...\n');

const started = Date.now();
try {
  const res = await provider.generate({
    modelId: toModelId(modelId),
    messages: [
      { role: 'system', content: 'You are a rigorous startup strategy analyst. Be concrete and specific.' },
      { role: 'user', content: PROMPT },
    ],
    maxOutputTokens: 4000,
  });

  console.log('─'.repeat(78));
  console.log(res.output);
  console.log('─'.repeat(78));
  console.log(`finishStatus : ${res.finishStatus}`);
  console.log(`modelVersion : ${res.modelVersion ?? '(none reported)'}`);
  console.log(`tokens       : in=${res.usage.inputTokens} out=${res.usage.outputTokens} total=${res.usage.totalTokens}`);
  // The same estimate lane the gateway meters with: $5/1M input, $25/1M output for Opus 5.
  const micros = res.usage.inputTokens * 5 + res.usage.outputTokens * 25;
  console.log(`est. cost    : ${micros} micro-USD (~$${(micros / 1_000_000).toFixed(4)})`);
  console.log(`wall clock   : ${Date.now() - started} ms`);
} catch (err) {
  // The provider already normalized this; print only the PUBLIC envelope so a raw provider string (or anything
  // resembling a credential) cannot reach a terminal that may be pasted into an issue.
  const publicView = typeof err?.toPublic === 'function' ? err.toPublic() : { category: 'unknown' };
  console.error('the call failed:', JSON.stringify(publicView));
  process.exit(1);
}
