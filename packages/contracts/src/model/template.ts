// @acbp/contracts — provider-neutral PROMPT/TEMPLATE REGISTRY (ACBP-P2-004; CDR-027; ADR-011 `template_ref@version`;
// AI-AND-WORKER-ARCHITECTURE §1). Versioned prompt templates per capability/task-type, each declaring its gateway
// TASK CLASS. The registry RESOLVES a `templateRef` (`family@version`) to a pinned, immutable template and yields
// bounded PROVENANCE (`{template_ref, template_version}`) stamped on every derived artifact for attribution
// (TASK-005). It is CONFIG, not tenant data: global, versioned, no DB, no RLS. Provider-neutral — provider
// dialects/names live ONLY in the gateway adapters + configuration, never here. Deny-by-default: an unregistered
// ref, an undeclared slot, or a missing slot value is REJECTED. Zero-dependency leaf beyond the shared error
// helper + the `TaskClass` vocabulary.
import { validationError } from '../errors.js';
import type { TaskClass } from './gateway.js';

/** One template message segment: a role + provider-neutral text that may contain `{{slot}}` placeholders. */
export interface TemplateSegment {
  readonly role: 'system' | 'user' | 'assistant';
  readonly text: string;
}

/**
 * A pinned, IMMUTABLE template version. `family` (dot-namespaced capability/task-type) groups versions; `version`
 * is a positive integer bumped on any content change (never edited in place — a change is a new version, so
 * provenance stays reproducible). `taskClass` binds the gateway timeout/fallback policy. `slots` are the named
 * inputs the caller (context assembly, P2-007) must fill; they must EXACTLY match the `{{...}}` placeholders used.
 */
export interface TemplateDefinition {
  readonly family: string;
  readonly version: number;
  readonly taskClass: TaskClass;
  readonly segments: readonly TemplateSegment[];
  readonly slots: readonly string[];
}

/** Bounded provenance stamped on every derived artifact (TASK-005): the pinned ref + its integer version. */
export interface TemplateProvenance {
  readonly template_ref: string;
  readonly template_version: number;
}

// ---------------------------------------------------------------------------------------------------
// The CLOSED, versioned registry (v1 seeds). New families/versions are added DELIBERATELY by later
// tickets (P2-005/P2-007/P2-008 refine the prompt content); an unregistered ref is rejected. Content is
// intentionally minimal + provider-neutral: the v1 deliverable is the versioning/resolution/provenance
// MECHANISM, not final prompt wording.
// ---------------------------------------------------------------------------------------------------

/** Closed set of template family names (dot-namespaced capability/task-type). */
export const TEMPLATE_FAMILIES = ['interview.followups', 'interview.answer_quality', 'interview.assumption', 'understanding.generate', 'extraction.fields', 'classification.intent'] as const;
export type TemplateFamily = (typeof TEMPLATE_FAMILIES)[number];

export function isTemplateFamily(v: unknown): v is TemplateFamily {
  return typeof v === 'string' && (TEMPLATE_FAMILIES as readonly string[]).includes(v);
}

// Annotated as `readonly TemplateDefinition[]` so each literal is contextually typed (segment `role` stays the
// literal union, not widened to `string`). Frozen at load for immutability (nested nodes are deep-frozen below).
const TEMPLATES: readonly TemplateDefinition[] = [
  // Adaptive interview follow-ups (consumed by P2-005). Quality-bearing → `generation` task class.
  {
    family: 'interview.followups',
    version: 1,
    taskClass: 'generation',
    slots: ['prior_answers', 'focus_area'],
    segments: [
      { role: 'system', text: 'You help interview a founder about their business. Ask at most three concise, specific follow-up questions. Never repeat what was already answered. Return only the questions.' },
      { role: 'user', text: 'Focus area: {{focus_area}}\nPrior answers:\n{{prior_answers}}' },
    ],
  },
  // Answer-quality detection (ACBP-P2-005; DISC-003/004). Classifies a founder answer as clear/vague/
  // contradictory; the structured verdict is enforced by the gateway output schema, not this wording.
  {
    family: 'interview.answer_quality',
    version: 1,
    taskClass: 'classification',
    slots: ['answer', 'prior_answers'],
    segments: [
      { role: 'system', text: 'You review a founder\'s interview answer. Decide whether it is clear, vague (too generic to be useful), or contradictory (conflicts with an earlier answer). For vague, give one specific clarifying question with an example; for contradictory, briefly describe the conflict. Return only the structured verdict.' },
      { role: 'user', text: 'Answer: {{answer}}\nEarlier answers:\n{{prior_answers}}' },
    ],
  },
  // Assumption suggestion on an "I don't know" answer (ACBP-P2-005; DISC-005). Produces ONE clearly-labeled
  // assumption; it is stored as an ai_assumption memory item, never as a stated fact.
  {
    family: 'interview.assumption',
    version: 1,
    taskClass: 'generation',
    slots: ['question', 'prior_answers'],
    segments: [
      { role: 'system', text: 'The founder answered "I don\'t know". Propose exactly one reasonable, clearly-labeled assumption to fill the gap, grounded in their earlier answers. Keep it to a single sentence, phrased explicitly as an assumption.' },
      { role: 'user', text: 'Question: {{question}}\nEarlier answers:\n{{prior_answers}}' },
    ],
  },
  // Understanding generation (ACBP-P2-008; DISC → UNDER-001). Classifies the confirmed memory into the closed
  // 6-class set with confidence; the structured output is enforced by the gateway output schema, not this wording.
  {
    family: 'understanding.generate',
    version: 1,
    taskClass: 'generation',
    slots: ['memory'],
    segments: [
      { role: 'system', text: 'You produce a structured business-understanding document from the founder\'s confirmed information. Classify each item as one of: fact, preference, constraint, assumption, research_finding, or open_question, and give each a confidence between 0 and 1. Do not invent facts; mark genuine gaps as open_question. Return only the structured items.' },
      { role: 'user', text: 'Confirmed information:\n{{memory}}' },
    ],
  },
  // Structured field extraction (extraction task class — fallback-eligible, interactive timeout).
  {
    family: 'extraction.fields',
    version: 1,
    taskClass: 'extraction',
    slots: ['source_text'],
    segments: [
      { role: 'system', text: 'Extract the requested fields from the provided text. Use the exact field names given by the output schema. If a field is absent, mark it unknown rather than guessing.' },
      { role: 'user', text: '{{source_text}}' },
    ],
  },
  // Short-label classification (classification task class).
  {
    family: 'classification.intent',
    version: 1,
    taskClass: 'classification',
    slots: ['input_text'],
    segments: [
      { role: 'system', text: 'Classify the input into exactly one of the labels defined by the output schema. Return only the chosen label.' },
      { role: 'user', text: '{{input_text}}' },
    ],
  },
];

// ---------------------------------------------------------------------------------------------------
// Validation + self-consistency (deny-by-default).
// ---------------------------------------------------------------------------------------------------

const FAMILY_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/; // dot-namespaced, ≥2 segments
const SLOT_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_VERSION = 9999;
const SLOT_PLACEHOLDER_RE = /\{\{\s*([a-z][a-z0-9_]{0,63})\s*\}\}/g;

/** The `{{slot}}` names referenced by a template's segments (deduplicated, in first-seen order). */
function placeholdersOf(def: TemplateDefinition): string[] {
  const seen: string[] = [];
  for (const seg of def.segments) {
    for (const m of seg.text.matchAll(SLOT_PLACEHOLDER_RE)) {
      const name = m[1]!;
      if (!seen.includes(name)) seen.push(name);
    }
  }
  return seen;
}

// Build the resolution index ONCE, asserting registry self-consistency at module load so a malformed seed can
// never ship: unique `family@version`, valid family/version/slots, and declared slots ⇔ used placeholders.
const BY_REF: ReadonlyMap<string, TemplateDefinition> = (() => {
  const map = new Map<string, TemplateDefinition>();
  for (const def of TEMPLATES) {
    if (!FAMILY_RE.test(def.family)) throw new Error(`template registry: invalid family "${def.family}"`);
    if (!Number.isInteger(def.version) || def.version < 1 || def.version > MAX_VERSION) throw new Error(`template registry: invalid version for ${def.family}`);
    if (def.segments.length === 0) throw new Error(`template registry: ${def.family}@${def.version} has no segments`);
    const declared = [...def.slots];
    for (const s of declared) if (!SLOT_RE.test(s)) throw new Error(`template registry: invalid slot "${s}" in ${def.family}@${def.version}`);
    if (new Set(declared).size !== declared.length) throw new Error(`template registry: duplicate slot in ${def.family}@${def.version}`);
    const used = placeholdersOf(def);
    for (const u of used) if (!declared.includes(u)) throw new Error(`template registry: ${def.family}@${def.version} uses undeclared slot "${u}"`);
    for (const d of declared) if (!used.includes(d)) throw new Error(`template registry: ${def.family}@${def.version} declares unused slot "${d}"`);
    const ref = `${def.family}@${def.version}`;
    if (map.has(ref)) throw new Error(`template registry: duplicate ref ${ref}`);
    map.set(ref, def);
    def.segments.forEach((seg) => Object.freeze(seg));
    Object.freeze(def.segments);
    Object.freeze(def.slots);
    Object.freeze(def);
  }
  Object.freeze(TEMPLATES);
  return map;
})();

// ---------------------------------------------------------------------------------------------------
// Public resolution + provenance.
// ---------------------------------------------------------------------------------------------------

/** The pinned reference string for a template definition. */
export function templateRef(def: TemplateDefinition): string {
  return `${def.family}@${def.version}`;
}

/**
 * Resolve a `family@version` reference to its pinned, immutable template. Deny-by-default: a malformed ref or an
 * unregistered family/version throws a validation error (never a silent fallback to a different version).
 */
export function resolveTemplateRef(ref: string): TemplateDefinition {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 128) {
    throw validationError({ message: 'Template ref is invalid.', fields: ['templateRef'] });
  }
  const at = ref.indexOf('@');
  if (at <= 0 || at !== ref.lastIndexOf('@')) {
    throw validationError({ message: 'Template ref must be exactly family@version.', fields: ['templateRef'] });
  }
  const family = ref.slice(0, at);
  const versionText = ref.slice(at + 1);
  if (!/^[1-9][0-9]{0,3}$/.test(versionText)) {
    throw validationError({ message: 'Template ref version must be a positive integer.', fields: ['templateRef'] });
  }
  const def = BY_REF.get(`${family}@${Number(versionText)}`);
  if (def === undefined) {
    throw validationError({ message: 'Template ref is not registered.', fields: ['templateRef'] });
  }
  return def;
}

/** The highest registered version of a family (latest). Throws if the family has no registered template. */
export function latestTemplate(family: string): TemplateDefinition {
  let best: TemplateDefinition | undefined;
  for (const def of TEMPLATES) {
    if (def.family === family && (best === undefined || def.version > best.version)) best = def;
  }
  if (best === undefined) throw validationError({ message: 'Template family is not registered.', fields: ['family'] });
  return best;
}

/** The pinned ref for the latest version of a family (callers pin this ref before calling the gateway). */
export function latestTemplateRef(family: string): string {
  return templateRef(latestTemplate(family));
}

/** Every registered template (read-only snapshot) — for catalogs, coverage checks, and neutrality scans. */
export function listTemplates(): readonly TemplateDefinition[] {
  return TEMPLATES;
}

/** Bounded provenance for artifact attribution (TASK-005): the pinned ref + integer version. */
export function templateProvenance(def: TemplateDefinition): TemplateProvenance {
  return Object.freeze({ template_ref: templateRef(def), template_version: def.version });
}

/**
 * Render a template's OWN segments by substituting its declared `{{slot}}` placeholders with `values`. This is the
 * registry rendering its own template — combining the result with ranked memory context, the secret blocklist,
 * and MEM-004 precedence is CONTEXT ASSEMBLY's job (P2-007). Deny-by-default: a missing value for a declared slot,
 * or an unknown key in `values`, is rejected (no silent blanks, no leaked extras).
 */
export function renderTemplateSegments(def: TemplateDefinition, values: Readonly<Record<string, string>>): TemplateSegment[] {
  const provided = Object.keys(values);
  for (const key of provided) {
    if (!def.slots.includes(key)) {
      throw validationError({ message: 'Unknown template slot.', fields: [`values.${key}`] });
    }
  }
  for (const slot of def.slots) {
    if (typeof values[slot] !== 'string') {
      throw validationError({ message: 'Missing template slot value.', fields: [`values.${slot}`] });
    }
  }
  return def.segments.map((seg) => ({
    role: seg.role,
    text: seg.text.replace(SLOT_PLACEHOLDER_RE, (_m, name: string) => values[name] ?? ''),
  }));
}
