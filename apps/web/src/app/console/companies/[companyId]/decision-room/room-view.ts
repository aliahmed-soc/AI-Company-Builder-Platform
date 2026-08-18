/*
 * ACBP-FE-012 — turning the Decision Room read into something the screen can render.
 *
 * THE TRI-STATE SECTION IS THE WHOLE POINT, and it is where a queue UI normally lies. A section is `ok`,
 * `restricted` or `unavailable`, and only `ok` carries a count — the contract makes a zero-count refusal
 * unconstructable, because `nonAnsweringSection` sets `count: null` and an empty item list by construction.
 *
 * So this mapper must keep three things apart that a careless screen collapses into one empty queue:
 *   - "there is nothing in this queue"      — an `ok` section with count 0. The server looked and found none.
 *   - "you are not allowed to see this"     — `restricted`. The server looked and refused to say.
 *   - "this could not be read right now"    — `unavailable`. The server tried and failed.
 * Rendering the last two as "0" would invent an answer the server explicitly declined to give, which is the
 * exact shape of lie CDR-076 §0 says this contract exists to prevent.
 *
 * `truncated` IS A SECOND HONESTY FLAG. An `ok` section's `count` is the TRUE total while `items` is a
 * sample capped at 20, so a section can legitimately say "47" and show 20. The screen must show the count as
 * the count and say the list is a sample — showing `items.length` as the total would under-report by design.
 */
import type { DecisionRoomItem, DecisionRoomQueue, DecisionRoomSection, DecisionRoomView } from '@acbp/contracts';

export type QueueTone = 'has_items' | 'empty' | 'restricted' | 'unavailable';

export interface QueueView {
  readonly queue: DecisionRoomQueue;
  readonly label: string;
  readonly tone: QueueTone;
  /** The TRUE total, or null when the section did not answer. Never coerced to 0. */
  readonly count: number | null;
  /** What to show where a number goes — an em dash when there is no number to show. */
  readonly countLabel: string;
  readonly items: readonly DecisionRoomItem[];
  /** True when `items` is a sample rather than the whole queue. */
  readonly truncated: boolean;
  readonly note: string | null;
}

export interface RoomView {
  readonly queues: readonly QueueView[];
  readonly asOf: string;
  readonly digest: string;
  /** Queues the server actually answered for — the only ones whose counts may be summed. */
  readonly answeredCount: number;
  readonly totalQueues: number;
  /** True when at least one queue refused or failed, so the page must not present a complete picture. */
  readonly incomplete: boolean;
}

/**
 * Queue ids are snake_case machine words; this is the founder-facing label, not a new vocabulary.
 *
 * "ai" IS UPPER-CASED as a special case. Sentence-casing alone rendered one of the ten canonical queues as
 * "Questions from ai", which reads as a typo rather than as an initialism — a reviewer caught it, and the
 * label had no test at all until then.
 */
function labelFor(queue: string): string {
  return queue
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\bai\b/g, 'AI');
}

function toQueueView(section: DecisionRoomSection): QueueView {
  if (section.status === 'restricted') {
    return {
      queue: section.queue,
      label: labelFor(section.queue),
      tone: 'restricted',
      count: null,
      countLabel: '—',
      items: [],
      truncated: false,
      note: 'You are not permitted to see this queue, so the server did not say how many items it holds. That is different from the queue being empty.',
    };
  }
  if (section.status === 'unavailable') {
    return {
      queue: section.queue,
      label: labelFor(section.queue),
      tone: 'unavailable',
      count: null,
      countLabel: '—',
      items: [],
      truncated: false,
      note: 'This queue could not be read just now. Its contents are unknown rather than empty, and the rest of this page is unaffected.',
    };
  }
  const count = section.count ?? 0;
  return {
    queue: section.queue,
    label: labelFor(section.queue),
    tone: count === 0 ? 'empty' : 'has_items',
    count,
    countLabel: String(count),
    items: section.items,
    truncated: section.truncated,
    // Only stated when the server said so. `count` is the true total and `items` a capped sample, so a
    // truncated section is showing part of what it counted.
    note: section.truncated ? `Showing ${String(section.items.length)} of ${String(count)}. The rest are not listed here.` : null,
  };
}

/**
 * `room.integrity` AND `room.usage` ARE DELIBERATELY NOT RENDERED, and that is written down rather than
 * left to be discovered. They are separate surfaces — an integrity counter and an account usage summary —
 * each with its own honesty rules, and neither belongs in a queue list. A reviewer noticed they were being
 * silently discarded, which is exactly why the omission needs to be a stated decision instead of an
 * accident of what this mapper happened to read.
 */
export function toRoomView(room: DecisionRoomView): RoomView {
  const queues = room.sections.map(toQueueView);
  const answered = queues.filter((q) => q.count !== null).length;
  return {
    queues,
    asOf: room.asOf,
    digest: room.digest,
    answeredCount: answered,
    totalQueues: queues.length,
    incomplete: answered < queues.length,
  };
}

/**
 * The one sentence the polite live region announces about the room itself. Pure over server state, so an
 * unchanged room yields an identical string and the region stays silent.
 *
 * It counts ANSWERED queues, never all ten: summing a restricted queue as zero would be the same lie the
 * tri-state exists to prevent, one level up.
 */
export function describeRoom(view: RoomView): string {
  const items = view.queues.reduce((n, q) => n + (q.count ?? 0), 0);
  if (view.incomplete) {
    return `${String(items)} items across ${String(view.answeredCount)} of ${String(view.totalQueues)} queues. The remaining queues did not report, so this is not a complete picture.`;
  }
  return `${String(items)} items across all ${String(view.totalQueues)} queues.`;
}
