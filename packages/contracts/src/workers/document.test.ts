// ACBP-P5-008 — "quality-check fail = draft marked needs-revision" (CDR-063; WORK-004).
//
// This worker is the only one of the three that KEEPS its output when the check fails, because a half-finished
// business plan is editable and discarding it throws away work. What would be wrong is presenting it as finished —
// so almost every test here is about whether the draft admits to being one.
import { describe, test, expect } from 'vitest';
import { DOCUMENT_TYPES, isDocumentType, parseDocumentOutput, assessDocumentQuality, renderDocumentMarkdown, MAX_DOCUMENT_SECTIONS } from './document.js';

const section = (heading: string, body: string) => ({ heading, body });
const REFS = ['understanding:v3', 'decision:d-77'];
const doc = (over: Record<string, unknown> = {}) => ({
  documentType: 'business_plan_generation',
  title: 'Business plan',
  contextRefs: REFS,
  sections: [section('Summary', 'A real summary with content.'), section('Market', 'A real market description.')],
  ...over,
});

describe('the three document types canon names', () => {
  test('are exactly business plan, landing-page copy and internal product requirements', () => {
    expect([...DOCUMENT_TYPES]).toEqual(['business_plan_generation', 'landing_page_copy', 'internal_product_requirements']);
    for (const t of DOCUMENT_TYPES) expect(isDocumentType(t)).toBe(true);
    for (const bad of ['pitch_deck', 'BUSINESS_PLAN_GENERATION', '', null, 4]) expect(isDocumentType(bad)).toBe(false);
  });

  test('an unrecognised type is refused', () => {
    expect(parseDocumentOutput(doc({ documentType: 'pitch_deck' }))).toMatchObject({ ok: false, reason: 'unknown_document_type' });
  });
});

describe('structure — "editable" means sections, not a blob', () => {
  test('a document with sections parses', () => {
    expect(parseDocumentOutput(doc())).toMatchObject({ ok: true });
  });

  test('no sections at all is refused — that is not a draft, it is nothing', () => {
    expect(parseDocumentOutput(doc({ sections: [] }))).toMatchObject({ ok: false, reason: 'no_sections' });
  });

  test('a section needs a heading — an unlabelled block cannot be revised in isolation', () => {
    expect(parseDocumentOutput(doc({ sections: [section('  ', 'body')] }))).toMatchObject({ ok: false, reason: 'invalid_section' });
  });

  test('two sections with the SAME heading are refused — "editable" needs addressable sections', () => {
    // Review pass 2. A revision workflow has to address a section by something, and "the one called Market" stops
    // identifying anything when there are two. The needs-revision warning names sections by heading too.
    expect(parseDocumentOutput(doc({ sections: [section('Market', 'a'), section('market ', 'b')] }))).toMatchObject({ ok: false, reason: 'duplicate_heading', index: 1 });
  });

  test('a blank BODY parses — it is a quality problem, not a structural one', () => {
    // The distinction that makes this worker work: an empty section is something the founder can see and fill in, so
    // it flows to the quality check rather than being refused at the door.
    expect(parseDocumentOutput(doc({ sections: [section('Summary', '   ')] }))).toMatchObject({ ok: true });
  });

  test('the section count is bounded at its exact limit', () => {
    const many = Array.from({ length: MAX_DOCUMENT_SECTIONS }, (_, i) => section(`H${i}`, 'body'));
    expect(parseDocumentOutput(doc({ sections: many }))).toMatchObject({ ok: true });
    expect(parseDocumentOutput(doc({ sections: [...many, section('One more', 'body')] }))).toMatchObject({ ok: false, reason: 'too_many_sections' });
  });

  test('a malformed document is refused rather than partly accepted', () => {
    for (const bad of [undefined, null, {}, 'a document', 9, doc({ sections: 'many' }), doc({ title: '' })]) {
      expect(parseDocumentOutput(bad)).toMatchObject({ ok: false });
    }
  });
});

describe('G5 — provenance is required', () => {
  test('a document citing NO context refs is refused outright', () => {
    // Not a draft — a build with no inputs. Canon asks for documents "with provenance" and the acceptance repeats it.
    expect(parseDocumentOutput(doc({ contextRefs: [] }))).toMatchObject({ ok: false, reason: 'no_provenance' });
    expect(parseDocumentOutput(doc({ contextRefs: undefined }))).toMatchObject({ ok: false, reason: 'no_provenance' });
  });

  test('a blank or duplicated ref is refused', () => {
    expect(parseDocumentOutput(doc({ contextRefs: ['  '] }))).toMatchObject({ ok: false, reason: 'invalid_provenance' });
    expect(parseDocumentOutput(doc({ contextRefs: ['understanding:v3', 'understanding:v3'] }))).toMatchObject({ ok: false, reason: 'invalid_provenance' });
  });
});

describe('G1/G4 — the quality check finds EMPTINESS, and derives the status', () => {
  test('a document whose sections all have real content is complete', () => {
    const parsed = parseDocumentOutput(doc());
    if (!parsed.ok) throw new Error('setup');
    expect(assessDocumentQuality(parsed.document)).toEqual({ status: 'complete', failingSections: [] });
  });

  test('a blank section makes the document needs_revision, and NAMES it', () => {
    const parsed = parseDocumentOutput(doc({ sections: [section('Summary', 'Real.'), section('Market', '   ')] }));
    if (!parsed.ok) throw new Error('setup');
    expect(assessDocumentQuality(parsed.document)).toEqual({ status: 'needs_revision', failingSections: ['Market'] });
  });

  test('placeholder text is emptiness wearing a costume', () => {
    // The failure this check exists for: a document that LOOKS written, section by section, and says nothing. Each
    // of these is a model declining to write while appearing to have written.
    // `{{value}}` and `((x))` are here because review pass 1 found the regex did NOT match the mustache form its own
    // comment offered as an example — the opener consumed one brace and the trailing one had nothing left to match.
    for (const placeholder of ['TBD', 'tbd', 'TODO', 'To be determined', '[insert market size]', '<describe the offer>', '{{value}}', '((x))', 'N/A', 'Lorem ipsum dolor sit amet', 'xxx', '...']) {
      const parsed = parseDocumentOutput(doc({ sections: [section('Summary', 'Real content here.'), section('Market', placeholder)] }));
      if (!parsed.ok) throw new Error(`setup: ${placeholder}`);
      expect(assessDocumentQuality(parsed.document), placeholder).toMatchObject({ status: 'needs_revision', failingSections: ['Market'] });
    }
  });

  test('a section that merely CONTAINS the word "todo" in real prose is NOT a failure', () => {
    // Guarding the guard. "Our todo list for launch is short" is written content; flagging it would train founders
    // to ignore the warning, which is worse than not having one.
    const prose = 'The team keeps a todo list for launch, reviewed weekly, covering the first three hires.';
    const parsed = parseDocumentOutput(doc({ sections: [section('Summary', 'Real.'), section('Plan', prose)] }));
    if (!parsed.ok) throw new Error('setup');
    expect(assessDocumentQuality(parsed.document)).toMatchObject({ status: 'complete' });
  });

  test('EVERY failing section is named, not just the first', () => {
    const parsed = parseDocumentOutput(doc({ sections: [section('A', 'TBD'), section('B', 'Real.'), section('C', '')] }));
    if (!parsed.ok) throw new Error('setup');
    expect(assessDocumentQuality(parsed.document)).toEqual({ status: 'needs_revision', failingSections: ['A', 'C'] });
  });
});

describe('G2 — the draft admits it is a draft, in the bytes a founder reads', () => {
  test('a needs_revision document opens with the warning, BEFORE any content', () => {
    // A status that lives only in a database column is the hollow success wearing different clothes: the founder
    // opens the document, sees no warning, and treats it as done.
    const parsed = parseDocumentOutput(doc({ sections: [section('Summary', 'Real.'), section('Market', 'TBD')] }));
    if (!parsed.ok) throw new Error('setup');
    const assessment = assessDocumentQuality(parsed.document);
    const markdown = renderDocumentMarkdown(parsed.document, assessment);

    expect(markdown).toContain('NEEDS REVISION');
    expect(markdown).toContain('Market');
    // Before the content: the warning is above the first section heading, not appended at the end.
    expect(markdown.indexOf('NEEDS REVISION')).toBeLessThan(markdown.indexOf('## Summary'));
  });

  test('a complete document carries NO warning — the label has to mean something', () => {
    const parsed = parseDocumentOutput(doc());
    if (!parsed.ok) throw new Error('setup');
    const markdown = renderDocumentMarkdown(parsed.document, assessDocumentQuality(parsed.document));
    expect(markdown).not.toContain('NEEDS REVISION');
  });

  test('the provenance is rendered — a document with provenance nobody can see has none', () => {
    const parsed = parseDocumentOutput(doc());
    if (!parsed.ok) throw new Error('setup');
    const markdown = renderDocumentMarkdown(parsed.document, assessDocumentQuality(parsed.document));
    for (const ref of REFS) expect(markdown).toContain(ref);
  });

  test('sections render in their given order, with headings and bodies', () => {
    const parsed = parseDocumentOutput(doc());
    if (!parsed.ok) throw new Error('setup');
    const markdown = renderDocumentMarkdown(parsed.document, assessDocumentQuality(parsed.document));
    expect(markdown.indexOf('## Summary')).toBeLessThan(markdown.indexOf('## Market'));
    expect(markdown).toContain('A real market description.');
  });
});
