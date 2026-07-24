// @acbp/contracts — prompt/template registry tests (ACBP-P2-004; CDR-027). Pure, deterministic (no DB, no
// network). Proves resolution (deny-unknown), latest-version pinning, provenance stamping, slot rendering
// (deny missing/unknown), registry self-consistency, and provider-neutrality.
import { describe, test, expect } from 'vitest';
import { isPlatformError } from '../errors.js';
import { TASK_CLASS_POLICY } from './gateway.js';
import {
  TEMPLATE_FAMILIES,
  isTemplateFamily,
  templateRef,
  resolveTemplateRef,
  latestTemplate,
  latestTemplateRef,
  listTemplates,
  templateProvenance,
  renderTemplateSegments,
} from './template.js';

describe('template registry — resolution', () => {
  test('every registered family resolves to a pinned template with a valid task class', () => {
    for (const family of TEMPLATE_FAMILIES) {
      const def = latestTemplate(family);
      expect(def.family).toBe(family);
      expect(def.version).toBeGreaterThanOrEqual(1);
      expect(Object.prototype.hasOwnProperty.call(TASK_CLASS_POLICY, def.taskClass)).toBe(true);
      const round = resolveTemplateRef(templateRef(def));
      expect(round).toBe(def); // same frozen instance — resolution is exact, not a copy
    }
    // NOTE: every v1 seed family has exactly ONE version, so `latestTemplate`'s max-version selection path is not
    // exercised across multiple versions here; it is genuinely proven at the first version bump (a consuming
    // ticket, e.g. P2-008). The single-version registry is the accepted v1 state.
  });

  test('the seed families span their declared task classes (the v1 spanning claim, enforced)', () => {
    // Each seed maps to its SPECIFIC gateway task class — not merely "some" valid class.
    expect(latestTemplate('interview.followups').taskClass).toBe('generation');
    expect(latestTemplate('extraction.fields').taskClass).toBe('extraction');
    expect(latestTemplate('classification.intent').taskClass).toBe('classification');
    // ACBP-P2-005 additions: answer-quality detection classifies; assumption suggestion generates.
    expect(latestTemplate('interview.answer_quality').taskClass).toBe('classification');
    expect(latestTemplate('interview.assumption').taskClass).toBe('generation');
  });

  test('latestTemplateRef pins family@version and round-trips', () => {
    const ref = latestTemplateRef('extraction.fields');
    expect(ref).toBe('extraction.fields@1');
    expect(resolveTemplateRef(ref).family).toBe('extraction.fields');
  });

  test('isTemplateFamily is a closed guard', () => {
    expect(isTemplateFamily('extraction.fields')).toBe(true);
    expect(isTemplateFamily('nope.nope')).toBe(false);
    expect(isTemplateFamily(42)).toBe(false);
  });

  test('deny-by-default: unregistered family and version are rejected', () => {
    expect(() => resolveTemplateRef('unknown.family@1')).toThrow();
    expect(() => resolveTemplateRef('extraction.fields@999')).toThrow(); // family exists, version does not
    expect(() => latestTemplate('unknown.family')).toThrow();
  });

  test('malformed refs are rejected (no silent fallback to a version)', () => {
    for (const bad of ['', 'extraction.fields', 'extraction.fields@', '@1', 'extraction.fields@0', 'extraction.fields@01', 'extraction.fields@1@2', 'extraction.fields@v1', 'extraction.fields@1.0', 'a'.repeat(200) + '@1']) {
      const err = (() => { try { resolveTemplateRef(bad); return undefined; } catch (e) { return e; } })();
      expect(err, `expected "${bad}" to be rejected`).toBeDefined();
      expect(isPlatformError(err)).toBe(true);
    }
  });
});

describe('template registry — provenance (TASK-005)', () => {
  test('provenance carries the pinned ref + integer version, nothing else', () => {
    const def = latestTemplate('interview.followups');
    const prov = templateProvenance(def);
    expect(prov).toEqual({ template_ref: 'interview.followups@1', template_version: 1 });
    expect(Object.keys(prov).sort()).toEqual(['template_ref', 'template_version']);
    expect(Number.isInteger(prov.template_version)).toBe(true);
  });
});

describe('template registry — rendering (deny missing/unknown slots)', () => {
  test('renders declared slots and replaces every placeholder', () => {
    const def = latestTemplate('interview.followups');
    const out = renderTemplateSegments(def, { prior_answers: 'We sell coffee.', focus_area: 'pricing' });
    const joined = out.map((s) => s.text).join('\n');
    expect(joined).toContain('pricing');
    expect(joined).toContain('We sell coffee.');
    expect(joined).not.toMatch(/\{\{.*\}\}/); // no unfilled placeholders remain
    expect(out.map((s) => s.role)).toEqual(def.segments.map((s) => s.role)); // roles preserved
  });

  test('a missing value for a declared slot is rejected (no silent blanks)', () => {
    const def = latestTemplate('interview.followups');
    const err = (() => { try { renderTemplateSegments(def, { focus_area: 'pricing' }); return undefined; } catch (e) { return e; } })(); // prior_answers missing
    expect(isPlatformError(err)).toBe(true);
  });

  test('an unknown slot key is rejected (no leaked extras)', () => {
    const def = latestTemplate('extraction.fields');
    const err = (() => { try { renderTemplateSegments(def, { source_text: 'x', secret: 'y' }); return undefined; } catch (e) { return e; } })();
    expect(isPlatformError(err)).toBe(true);
  });
});

describe('template registry — self-consistency + provider-neutrality', () => {
  test('every template: declared slots exactly match the {{placeholders}} used', () => {
    const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,63})\s*\}\}/g;
    for (const def of listTemplates()) {
      const used = new Set<string>();
      for (const seg of def.segments) for (const m of seg.text.matchAll(PLACEHOLDER)) used.add(m[1]!);
      expect(new Set(def.slots)).toEqual(used);
    }
  });

  test('no provider name or dialect leaks into any template (ADR-011: provider-neutral)', () => {
    // Best-effort guard over the DISTINCTIVE provider/model/host tokens (deliberately excludes common English
    // words like "palm"/"azure"/"vertex" that would false-positive on legitimate business prompts). Scans the
    // family, slot names, AND segment text — not just the prompt body.
    const FORBIDDEN = ['openai', 'anthropic', 'gpt', 'claude', 'sonnet', 'opus', 'haiku', 'gemini', 'llama', 'mistral', 'cohere', 'bedrock', 'deepseek', 'qwen', 'grok', 'api key', 'apikey', 'bearer'];
    for (const def of listTemplates()) {
      const blob = [def.family, def.slots.join(' '), def.segments.map((s) => s.text).join('\n')].join('\n').toLowerCase();
      for (const token of FORBIDDEN) expect(blob, `${def.family}@${def.version} must not contain "${token}"`).not.toContain(token);
    }
  });

  test('registry covers exactly the declared family set (closed)', () => {
    const families = new Set(listTemplates().map((d) => d.family));
    expect([...families].sort()).toEqual([...TEMPLATE_FAMILIES].sort());
  });
});
