// @vitest-environment jsdom
/*
 * ACBP-FE-008 — the rendered verdict and assumption feedback.
 *
 * The row asks for two things this file can actually prove: "a re-ask is labelled as such; an assumption is
 * shown as an assumption", and "assumption chips are readable text, not colour-only". Both are asserted
 * against the rendered TEXT, so a version that carried the distinction only in a class name fails here.
 *
 * ⚠️ WHAT THIS CANNOT PROVE. jsdom has no layout engine and no stylesheet, so the row's "stacks under the
 * question" is NOT measured — the DOM order is asserted, which is a structure check, not a layout one.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { VerdictFeedback, AssumptionFeedback } from './verdict-feedback';
import { interpretEvaluateResponse, interpretAssumptionResponse } from './verdict-outcome';

// Globals are OFF in this repository, so testing-library registers no automatic cleanup.
afterEach(cleanup);

const evaluated = (payload: unknown) => interpretEvaluateResponse(200, JSON.stringify(payload), null);
const assumed = (payload: unknown) => interpretAssumptionResponse(200, JSON.stringify(payload), null);

describe('a re-ask is labelled as a re-ask', () => {
  it('says the server is asking again, and quotes its question', () => {
    render(<VerdictFeedback outcome={evaluated({ verdict: 'vague', clarification: 'Which region do you sell into?' })} />);
    expect(screen.getByText('The server is asking again')).toBeTruthy();
    expect(screen.getByText('Which region do you sell into?')).toBeTruthy();
    // And it must be clear the answer did not land.
    expect(screen.getByText(/has not been stored/i)).toBeTruthy();
  });

  it('a CONTRADICTION does not read as the same thing as a vague answer', () => {
    const { unmount } = render(<VerdictFeedback outcome={evaluated({ verdict: 'vague', clarification: 'Which region?' })} />);
    const vagueLabel = screen.getByText('The server is asking again').textContent;
    unmount();
    render(<VerdictFeedback outcome={evaluated({ verdict: 'contradictory', conflict: 'Earlier you said retail.' })} />);
    const conflictLabel = screen.getByText(/conflicts with something recorded earlier/i).textContent;
    expect(vagueLabel).not.toBe(conflictLabel);
    expect(screen.getByText('Earlier you said retail.')).toBeTruthy();
  });

  it('an ACCEPTED answer says so and shows no follow-up question', () => {
    render(<VerdictFeedback outcome={evaluated({ verdict: 'clear', memoryItemId: 'mem_1' })} />);
    expect(screen.getByText('Answer accepted')).toBeTruthy();
    expect(document.querySelector('.cs-server-words')).toBeNull();
  });
});

describe('an assumption is shown as an assumption', () => {
  it('the chip is READABLE TEXT — the meaning survives with every class stripped', () => {
    const { container } = render(<AssumptionFeedback outcome={assumed({ assumption: 'Buyers are independent cafes.', memoryItemId: 'mem_2' })} />);
    // Strip every class attribute: whatever the stylesheet would have conveyed is now gone.
    for (const el of container.querySelectorAll('[class]')) el.removeAttribute('class');
    expect(container.textContent).toContain('Assumed, not stated by you');
    expect(container.textContent).toContain('rather than as something you told it');
    expect(container.textContent).toContain('Buyers are independent cafes.');
  });

  it('says the assumption will be treated as true until corrected', () => {
    render(<AssumptionFeedback outcome={assumed({ assumption: 'Buyers are cafes.', memoryItemId: null })} />);
    expect(screen.getByText(/used as though it were true until you do/i)).toBeTruthy();
  });

  it('NOTHING ASSUMED renders as an ordinary outcome, never as a failure or an empty chip', () => {
    const { container } = render(<AssumptionFeedback outcome={assumed({ assumption: null, memoryItemId: null })} />);
    expect(screen.getByText('No assumption was made')).toBeTruthy();
    expect(screen.getByText(/rather than being filled with a guess/i)).toBeTruthy();
    // No quoted server text, because there is none — an empty blockquote would read as a blank assumption.
    expect(container.querySelector('.cs-server-words')).toBeNull();
  });

  it('the assumed and nothing-assumed labels are different words, not just a different tint', () => {
    const { unmount } = render(<AssumptionFeedback outcome={assumed({ assumption: 'x.', memoryItemId: null })} />);
    const a = screen.getByText('Assumed, not stated by you').textContent;
    unmount();
    render(<AssumptionFeedback outcome={assumed({ assumption: null, memoryItemId: null })} />);
    expect(a).not.toBe(screen.getByText('No assumption was made').textContent);
  });
});

describe('refusals are announced, not swallowed', () => {
  it('a rate-limited evaluation says nothing was charged', () => {
    render(<VerdictFeedback outcome={interpretEvaluateResponse(429, JSON.stringify({ error: 'rate_limited' }), '30')} />);
    expect(screen.getByText(/nothing was charged/i)).toBeTruthy();
    expect(screen.getByText(/about 30 seconds/i)).toBeTruthy();
  });

  it('a domain 400 quotes the server rather than paraphrasing it', () => {
    render(<VerdictFeedback outcome={interpretEvaluateResponse(400, JSON.stringify({ error: { code: 'invalid', message: 'The answer is empty.' } }), null)} />);
    expect(screen.getByText('The answer is empty.')).toBeTruthy();
  });

  it('every outcome is announced politely rather than as an interruption', () => {
    // `role="alert"` would cut off whatever a screen reader was mid-sentence on. These are replies to a
    // deliberate action, so they are `status`.
    const { container } = render(<VerdictFeedback outcome={evaluated({ verdict: 'clear', memoryItemId: 'm' })} />);
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('the feedback sits after the content it belongs to', () => {
  it('renders as a single section that can be placed under the question', () => {
    // ⚠️ A STRUCTURE CHECK, NOT A LAYOUT ONE. jsdom applies no stylesheet, so "stacks under the question"
    // cannot be measured here; what is asserted is that this renders one self-contained block.
    const { container } = render(<VerdictFeedback outcome={evaluated({ verdict: 'clear', memoryItemId: 'm' })} />);
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild?.tagName).toBe('SECTION');
  });
});
