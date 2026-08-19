// @vitest-environment jsdom
/*
 * The console top bar makes no commercial claim.
 *
 * THE DEFECT THIS FILE GUARDS. The top bar used to render a badge reading "Growth", sourced from
 * `MOCK_COMPANY.plan`. There is no plan entity in this platform: no table, no contract type, no route, no
 * authorization action. `accounts.plan_state` (migration 0003) is the only plan-shaped column and it is
 * `'free'` by default with no vocabulary constraint, written by nothing and read by no API — its own comment
 * says concrete billing is Phase 7. So the badge did not merely lack a source; the nearest thing to a source
 * says the opposite word.
 *
 * WHY IT NEEDED A TEST RATHER THAN JUST A DELETION. The overview page carries a visible "mock data" banner.
 * The badge did not, because it lived in the LAYOUT — so it rendered above every console screen, including
 * the ones showing real database rows. Anything re-added to this header inherits that same reach, which is
 * why the assertion is on the header's text rather than on the one string that happened to be there.
 *
 * THE POSITIVE CONTROL IS NOT OPTIONAL. A layout that rendered nothing at all would satisfy "no billing
 * vocabulary in the header" perfectly. The name and initials are asserted first so a broken render fails
 * loudly instead of passing for the wrong reason.
 *
 * SCOPED TO THE HEADER ON PURPOSE. The sidebar has a nav group labelled "Plan" (Strategy / Roadmap / Tasks) —
 * that is the company's business plan, a real concept this platform does build. A repo-wide word ban would
 * catch it and mean nothing. The claim under test is narrower and true: the top bar states no entitlement.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import ConsoleLayout from './layout';
import { MOCK_COMPANY } from './mock-data';

// `NavLinks` is a client component calling `usePathname()`, which has no provider under jsdom. The value is
// irrelevant here — nothing in the top bar depends on it — but the hook must resolve for the tree to render.
vi.mock('next/navigation', () => ({ usePathname: () => '/console' }));

// Globals are OFF in this repository, so testing-library does not auto-register cleanup. Without this, a later
// test reads an earlier test's DOM and passes for the wrong reason.
afterEach(cleanup);

function renderShell(): HTMLElement {
  const { container } = render(<ConsoleLayout>{<p>content</p>}</ConsoleLayout>);
  const header = container.querySelector('header.cs-top');
  // A fixture that cannot produce the thing under test must throw, not hand back a null the assertions below
  // would quietly pass against.
  if (header === null) throw new Error('console top bar did not render — the assertions below would be vacuous');
  return header as HTMLElement;
}

/*
 * The header's words, SEPARATED — and this function is the whole reason the vocabulary assertion means anything.
 *
 * The first version of that test read `header.textContent` and PASSED while the badge was still on screen. DOM
 * `textContent` concatenates sibling elements with no separator, so the company name and the badge came back as
 * the single run `...CoffeeGrowth...`; `\bgrowth\b` needs a word boundary before the G and there is none between
 * two letters. The check could not have failed no matter what the badge said. Splitting on text NODES restores
 * the boundaries, and the test then failed on the real markup exactly as it should have from the start.
 */
function headerWords(header: HTMLElement): string {
  const walker = header.ownerDocument.createTreeWalker(header, 4 /* NodeFilter.SHOW_TEXT */);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) parts.push(node.textContent ?? '');
  return parts.join(' ');
}

describe('the console top bar', () => {
  it('renders the company it is scoped to (the positive control for everything below)', () => {
    const header = renderShell();
    expect(header.textContent).toContain(MOCK_COMPANY.name);
    expect(header.textContent).toContain(MOCK_COMPANY.initials);
  });

  it('claims no plan, tier, subscription or billing state', () => {
    const words = headerWords(renderShell());
    // Sanity: the separator is doing its job, so a failure below is about vocabulary and not about parsing.
    expect(words).toMatch(/\bCoffee\b/);
    expect(words).not.toMatch(/\b(plan|tier|subscription|billing|upgrade|free|pro|growth|premium|enterprise)\b/i);
  });

  it('renders no badge in the company chip', () => {
    const header = renderShell();
    const chip = header.querySelector('.cs-company');
    if (chip === null) throw new Error('company chip did not render — the assertion below would be vacuous');
    expect(chip.querySelectorAll('.cs-badge')).toHaveLength(0);
  });
});

describe('the mock company', () => {
  it('carries no plan field for a header to reach for', () => {
    expect(Object.keys(MOCK_COMPANY)).not.toContain('plan');
    // The durable half: re-adding the field is a COMPILE error here, not a runtime one found later. If the
    // field ever comes back legitimately, this line stops erroring and the directive itself fails the build,
    // which is the intended way for someone to be forced to read the comment at the top of this file.
    // @ts-expect-error `MOCK_COMPANY` must not have a `plan` property — see the file header.
    expect(MOCK_COMPANY.plan).toBeUndefined();
  });
});
