/*
 * ACBP-FE-010 — turning the memory list into something the browser can render.
 *
 * PURE ON PURPOSE, like `interview-view.ts` and `provisioning-view.ts` beside it: the page is a server
 * component and there are no Clerk keys in this environment, so anything not in a module like this one is
 * effectively unverified.
 *
 * FOUR FACTS ABOUT THIS API SHAPE EVERYTHING BELOW, and each is a place a screen could easily lie:
 *
 *  1. THE LIST IS SILENTLY CAPPED AT 100. `GET /memory` accepts only `type` and `currentOnly`; there is no
 *     limit, no cursor, no total and no truncation flag, and the response body carries none of them either.
 *     A full page therefore means "there may be more" and nothing stronger. That is why `capped` is an
 *     INPUT here rather than something this module infers: the caller counts what it received against the
 *     server's own default limit, and every row it produces is marked `historyKnown: false` when it was
 *     full. Without that, "this item has no earlier version" would be a claim the screen cannot support.
 *
 *  2. VERSION LINKS ARE FORWARD-ONLY. `MemoryItemDTO` carries `supersededBy` and NO `supersedes`. The
 *     backward link a founder actually wants ("what did this say before?") is therefore derived here, by
 *     inverting the forward pointers within the page. It is a derivation over server data, so it is
 *     honest — but it is THIS SCREEN'S RULE, and it cannot see past the page boundary.
 *
 *     `sourceRef` MUST NEVER BE USED FOR THIS. An edited item's `sourceRef` often looks like a pointer to
 *     the previous version, but it is a free caller-supplied string the server never resolves or validates
 *     — so treating it as a link would let a caller draw an arbitrary edge in the founder's history.
 *
 *  3. EDIT AND DELETE ARE OWNER-ONLY; READ IS NOT. `memory:edit` and `memory:delete` are owner-only while
 *     `memory:read`/`memory:write` are owner+viewer — and no memory response reveals the caller's role, so
 *     the gate is fed by the separate company read. A viewer shown enabled controls would get an opaque
 *     403 with no explanation of which of several causes applied.
 *
 *  4. ONLY THE CURRENT VERSION IS MUTABLE. The server refuses an edit or delete of a superseded item with
 *     a bare 409 that names no cause, so a superseded row's controls are disabled with the real reason.
 */
import type { MemoryConfirmationState, MemoryItemDTO, MemorySourceType, MemoryType } from '@acbp/contracts';

/** Available, or unavailable with a machine-readable cause AND a sentence — never one without the other. */
export type ControlState = { readonly kind: 'available' } | { readonly kind: 'unavailable'; readonly because: 'role' | 'lifecycle' | 'unknown'; readonly reason: string };

/** Three states, no two of which may share copy. `unknown` means nobody has successfully read the list. */
export type ItemsState = 'unknown' | 'none_exist' | 'has_items';

export interface MemoryRowView {
  readonly memoryItemId: string;
  readonly type: MemoryType;
  readonly content: string;
  readonly sourceType: MemorySourceType;
  /** Rendered as TEXT, never as a link: the server never resolves it and there is no deref endpoint. */
  readonly sourceRef: string;
  /** 'not scored' when null — null is the value the product itself always writes, and is not a zero score. */
  readonly confidenceLabel: string;
  readonly confirmationState: MemoryConfirmationState;
  readonly createdAt: string;
  /** Derived from `supersededBy`. 'deleted' is unreachable here: both reads omit deleted items entirely. */
  readonly lifecycle: 'active' | 'superseded';
  readonly supersededBy: string | null;
  /** The previous version, found by INVERTING supersededBy within this page. Never from `sourceRef`. */
  readonly previousVersionId: string | null;
  /** False when the page was full: the chain may extend past what was returned. See the header. */
  readonly historyKnown: boolean;
  readonly edit: ControlState;
  readonly delete: ControlState;
}

export interface MemoryView {
  readonly rows: readonly MemoryRowView[];
  readonly itemsState: ItemsState;
  readonly capped: boolean;
  readonly totalShown: number;
}

// The gate is the caller's role IN THIS COMPANY, not an account-level role: memory:edit and memory:delete
// are checked against the company-membership role, and only company:create uses the account role.
const OWNER_ONLY_REASON = 'Editing and deleting memory items is limited to a company owner. You can read every item here, and the server enforces this regardless of what this page shows.';
const SUPERSEDED_REASON = 'This is an earlier version, kept for the record. Only the current version can be edited or deleted, and the server refuses anything else.';
const UNKNOWN_ROLE_REASON = 'This page could not establish your role for this company, so it does not offer controls it cannot promise the server will accept.';

function controlsFor(role: string, superseded: boolean): { edit: ControlState; delete: ControlState } {
  // Role is reported BEFORE lifecycle: a viewer is refused for being a viewer whatever the row's state, and
  // telling them about the version instead would answer a question they did not ask.
  if (role !== 'owner' && role !== 'viewer') {
    const s: ControlState = { kind: 'unavailable', because: 'unknown', reason: UNKNOWN_ROLE_REASON };
    return { edit: s, delete: s };
  }
  if (role === 'viewer') {
    const s: ControlState = { kind: 'unavailable', because: 'role', reason: OWNER_ONLY_REASON };
    return { edit: s, delete: s };
  }
  if (superseded) {
    const s: ControlState = { kind: 'unavailable', because: 'lifecycle', reason: SUPERSEDED_REASON };
    return { edit: s, delete: s };
  }
  return { edit: { kind: 'available' }, delete: { kind: 'available' } };
}

/**
 * `items` is nullable ON PURPOSE and callers must NOT substitute an empty array for a missing read — an
 * unread list and an empty one are different facts, and only the second is something the server said.
 *
 * `capped` is supplied by the caller because only the caller knows how many items came back against the
 * server's own default limit; see the header.
 */
export function toMemoryView(items: readonly MemoryItemDTO[] | null, role: string, capped: boolean): MemoryView {
  const list = items ?? [];

  // Invert the forward pointers, within this page only. `supersededBy` naming an id the page never returned
  // yields no edge at all — drawing one would claim a version this screen cannot show.
  const present = new Set(list.map((i) => i.memoryItemId));
  const predecessorOf = new Map<string, string>();
  for (const i of list) {
    if (i.supersededBy !== null && present.has(i.supersededBy)) predecessorOf.set(i.supersededBy, i.memoryItemId);
  }

  const rows: MemoryRowView[] = list.map((i) => {
    const superseded = i.supersededBy !== null;
    const { edit, delete: del } = controlsFor(role, superseded);
    return {
      memoryItemId: i.memoryItemId,
      type: i.type,
      content: i.content,
      sourceType: i.sourceType,
      sourceRef: i.sourceRef,
      confidenceLabel: i.confidence === null ? 'not scored' : String(i.confidence),
      confirmationState: i.confirmationState,
      createdAt: i.createdAt,
      lifecycle: superseded ? 'superseded' : 'active',
      supersededBy: i.supersededBy,
      previousVersionId: predecessorOf.get(i.memoryItemId) ?? null,
      historyKnown: !capped,
      edit,
      delete: del,
    };
  });

  const itemsState: ItemsState = items === null ? 'unknown' : rows.length === 0 ? 'none_exist' : 'has_items';

  return { rows, itemsState, capped, totalShown: rows.length };
}

/**
 * The one short sentence the polite live region announces.
 *
 * PURE OVER SERVER STATE — the live region re-announces when its text changes, so "announce only on
 * movement" is a property of this function returning an identical string when nothing moved.
 */
export function describeMemory(view: MemoryView): string {
  switch (view.itemsState) {
    case 'unknown':
      return 'The memory list has not been read yet, so it is not known what this company has stored.';
    case 'none_exist':
      // Says the LIST is empty, not that the platform understands nothing. On this build no console surface
      // creates a memory item, so an empty table reflects an absent writer rather than an absent memory.
      return 'There are no memory items stored for this company yet.';
    case 'has_items':
    default:
      return view.capped
        ? `Showing the newest ${String(view.totalShown)} memory items. The server sends no total, so there may be more that are not listed.`
        : `Showing the ${String(view.totalShown)} memory items the server returned. Deleted items are not listed.`;
  }
}
