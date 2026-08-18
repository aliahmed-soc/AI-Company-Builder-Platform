// @vitest-environment jsdom
/*
 * ACBP-FE-019 — the first rendered-component test in this repository, and the wiring the FE-019 ruling owed.
 *
 * WHY THIS FILE EXISTS, in one sentence: 40 `.tsx` files and 4,782 lines of JSX had no test touching them, and
 * an independent review of ACBP-FE-013 found a BLOCKER that is exactly one render assertion — the harden
 * control rendered only while NO decision existed, so a founder who recorded a newer selection was shown "the
 * recorded decision hardened an EARLIER choice" by the screen itself and given no way to act on it.
 *
 * WHAT THIS HARNESS CAN AND CANNOT DO, because the row's own acceptance demo depends on the difference. The
 * row asks for a RED run against "a reintroduced horizontal overflow". **jsdom implements no layout engine** —
 * `offsetWidth`, `scrollWidth` and `getBoundingClientRect()` return zeros — so an overflow assertion here would
 * pass against a page that overflows catastrophically. That demo needs a real browser, which the ruling
 * defers with a named trigger. The RED demonstrated for THIS wiring is therefore behavioural, and the ruling
 * says so rather than quietly substituting one for the other.
 *
 * THE REGRESSION THIS FILE IS THE GUARD FOR: "refused" and "empty" are different answers. The task read
 * succeeding while the RUN read is refused must render as *the history could not be read*, never as *this task
 * has never been run* — the second is a claim about the company's work that the server did not make.
 *
 * PROVEN RED, AND THE FIRST MUTATION WAS THE WRONG ONE — recorded because the difference is the whole point.
 * Deleting the `runs === null` branch outright does redden this file, but with
 *     TypeError: Cannot read properties of null (reading 'length')
 * which proves only that the null check stops a crash. It says nothing about whether "refused" and "empty"
 * stay distinguishable, so it would have been a kill that did not test the claim.
 *
 * The mutation that ISOLATES the regression keeps the branch and makes the refused copy assert the empty-state
 * fact — "This task has never been run" inside the refusal paragraph. That fails with
 *     AssertionError: expected <p class="cs-refusal-detail"></p> to be null
 * on `queryByText(/has never been run/i)`: the forbidden claim, found in the refusal branch. THAT is the run
 * recorded in the commit message, and it is why this test is evidence for the branch rather than decoration.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { TaskDetailDTO } from '@acbp/contracts';
import { TaskExecutionScreen } from './task-execution-screen';
import type { RunLike } from '../run-view';

/*
 * EXPLICIT CLEANUP, AND IT IS NOT BOILERPLATE — the first run of this file proved it. `@testing-library/react`
 * auto-registers cleanup ONLY when vitest runs with `globals: true`, and this repository runs with globals
 * OFF. Without it every `render` accumulates in the same document, so a later test sees an earlier test's DOM:
 * the "an EMPTY history" case failed on
 *     AssertionError: expected <p class="cs-refusal-detail"></p> to be null
 * because the REFUSED render from the previous test was still mounted. A harness that leaks state between
 * tests does not merely fail — it passes for the wrong reason whenever the leak happens to help, which is the
 * precise failure mode this whole programme keeps removing.
 */
afterEach(cleanup);

const NOW = Date.parse('2026-08-18T12:00:00.000Z');

function task(over: Partial<TaskDetailDTO> = {}): TaskDetailDTO {
  return {
    taskId: 't-1',
    companyId: 'co-1',
    state: 'to_do',
    phase: 'not_started',
    title: 'Draft the pilot offer',
    description: null,
    milestoneId: null,
    taskType: 'research',
    priority: 0,
    createdAt: '2026-08-18T10:00:00.000Z',
    updatedAt: '2026-08-18T10:00:00.000Z',
    rationale: null,
    repeatedFromTaskId: null,
    controls: [],
    latestFailure: null,
    ...over,
  } as TaskDetailDTO;
}

function run(over: Partial<RunLike> = {}): RunLike {
  return {
    runId: 'run-1',
    taskId: 't-1',
    attempt: 1,
    state: 'succeeded',
    failureCategory: null,
    startedAt: '2026-08-18T11:00:00.000Z',
    lastHeartbeatAt: null,
    stopRequestedAt: null,
    endedAt: '2026-08-18T11:10:00.000Z',
    createdAt: '2026-08-18T10:59:00.000Z',
    updatedAt: '2026-08-18T11:10:00.000Z',
    ...over,
  };
}

describe('a refused run history is never rendered as an empty one', () => {
  it('says the history could not be READ, and does not claim the task was never run', () => {
    render(<TaskExecutionScreen task={task()} runs={null} runsRefusalStatus="forbidden" now={NOW} />);
    expect(screen.getByText(/could not be read/i)).not.toBeNull();
    // The claim that must NOT appear: an assertion about the company's work that the server never made.
    expect(screen.queryByText(/has never been run/i)).toBeNull();
  });

  it('an EMPTY history says the task was never run, and does not mention a refusal', () => {
    render(<TaskExecutionScreen task={task()} runs={[]} runsRefusalStatus={null} now={NOW} />);
    expect(screen.getByText(/has never been run/i)).not.toBeNull();
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });

  it('the two states are distinguishable by construction — they never render the same text', () => {
    const refused = render(<TaskExecutionScreen task={task()} runs={null} runsRefusalStatus="forbidden" now={NOW} />);
    const refusedText = refused.container.textContent ?? '';
    refused.unmount();
    const empty = render(<TaskExecutionScreen task={task()} runs={[]} runsRefusalStatus={null} now={NOW} />);
    expect(empty.container.textContent ?? '').not.toBe(refusedText);
  });
});

describe('a failure that has not happened renders nothing at all', () => {
  it('shows no failure card when latestFailure is null', () => {
    // `null` means HAS NOT FAILED. An empty card would be "a failure with every field blank", which the DTO's
    // own comment says TASK-006 forbids.
    render(<TaskExecutionScreen task={task({ latestFailure: null })} runs={[]} runsRefusalStatus={null} now={NOW} />);
    expect(screen.queryByText(/The latest failure/i)).toBeNull();
  });

  it('shows the card, the category and the retry ruling when one HAS happened', () => {
    render(
      <TaskExecutionScreen
        task={task({ latestFailure: { category: 'provider_error', summary: 'The provider refused the call.', attemptsUsed: 2, attemptsAllowed: 3, retrySafety: 'unsafe', nextAttempt: 'not_eligible' } })}
        runs={[]}
        runsRefusalStatus={null}
        now={NOW}
      />,
    );
    expect(screen.getByText(/The latest failure/i)).not.toBeNull();
    // `unsafe` is stated in terms of consequence, not as a status word.
    expect(screen.getByText(/may repeat an effect that already happened/i)).not.toBeNull();
  });
});

describe('control verdicts render with their reasons and offer nothing to click', () => {
  it('prints an unavailable control WITH the reason the server gave', () => {
    render(
      <TaskExecutionScreen
        task={task({ controls: [{ control: 'repeat', available: false, reason: 'not_finished' }] as TaskDetailDTO['controls'] })}
        runs={[]}
        runsRefusalStatus={null}
        now={NOW}
      />,
    );
    expect(screen.getByText(/repeat: not available/i)).not.toBeNull();
    expect(screen.getByText(/not_finished/i)).not.toBeNull();
  });

  it('renders NO button anywhere on the screen, because no control has a route', () => {
    // The load-bearing absence. A disabled button would be the same false promise with a tooltip on it, and
    // reading the source cannot prove the rendered output has none.
    const { container } = render(
      <TaskExecutionScreen
        task={task({ controls: [{ control: 'repeat', available: true, reason: null }] as TaskDetailDTO['controls'] })}
        runs={[run()]}
        runsRefusalStatus={null}
        now={NOW}
      />,
    );
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('a run says only what its state supports', () => {
  it('a finished run shows no heartbeat line at all', () => {
    render(<TaskExecutionScreen task={task()} runs={[run({ state: 'succeeded', endedAt: '2026-08-18T11:10:00.000Z' })]} runsRefusalStatus={null} now={NOW} />);
    expect(screen.queryByText(/heartbeat/i)).toBeNull();
  });

  it('a live run with a stale heartbeat reports the gap and never says the worker is lost', () => {
    render(<TaskExecutionScreen task={task()} runs={[run({ state: 'running', endedAt: null, lastHeartbeatAt: '2026-08-18T11:00:00.000Z' })]} runsRefusalStatus={null} now={NOW} />);
    expect(screen.getByText(/last heartbeat was/i)).not.toBeNull();
    // `worker_lost` is a ruling the SERVER makes. The screen may show the evidence and must not reach it.
    expect(screen.queryByText(/lost|dead|gone/i)).toBeNull();
  });
});
