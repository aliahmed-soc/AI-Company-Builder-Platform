'use client';

/*
 * ACBP-FE-010 — the memory browser's live half: the table, the edit form and the delete confirmation.
 *
 * EVERY MUTATION IS A SAME-ORIGIN `fetch`, and `content-type: application/json` is sent on PATCH ONLY.
 * `readJsonObject` checks the content type before reading a byte, so omitting it on the edit would 415
 * every submission; DELETE reads no body, so sending one there would be noise.
 *
 * THE RE-READ CARRIES NO QUERY STRING. `GET /memory` allows exactly `type` and `currentOnly` and answers a
 * bounded 400 to anything else, so a cache-buster would turn every refresh into a failure. Note also that
 * only the exact string `currentOnly=true` activates that filter — `currentOnly=false` is treated the same
 * as omitting it, so this screen sends `true` or nothing rather than something that reads as a negation.
 *
 * THE DELETE DIALOG IS THE HARDEST COPY IN THIS SCREEN and every clause in it is enforced by something
 * nameable. The row asks it to "say plainly whether it is permanent", and the honest answer is not a
 * yes or a no:
 *   - irreversible here — no restore, undelete or purge verb exists on any route;
 *   - but not an erasure — it is a soft delete, so the row and its content are retained and the action is
 *     itself audited;
 *   - it does remove the item from future generated context;
 *   - it retracts nothing already generated;
 *   - and where an earlier version is KNOWN to exist, that version stays visible and cannot be deleted.
 * The words "permanently", "erase", "gone forever" and "wiped" are therefore absent by design.
 *
 * Two clauses were removed after review rather than softened. "It still appears in your data export" was
 * true of the stored row but named a document no route or screen in this build can produce — a reassurance
 * pointing at a door that does not open. And the earlier-versions clause used to fire whenever the page was
 * FULL, which is exactly the state in which this screen has recorded that it cannot see the chain, so it
 * asserted that earlier versions were visible precisely when it did not know.
 */

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MEMORY_CONTENT_MAX, MEMORY_TYPES } from '@acbp/contracts';
import type { MemoryItemDTO, MemoryType } from '@acbp/contracts';
import { describeMemory, toMemoryView, type MemoryRowView } from './memory-view';
import { interpretDeleteResponse, interpretEditResponse, interpretListResponse, type DeleteOutcome, type EditOutcome } from './memory-outcome';

type RowOutcome = { readonly memoryItemId: string; readonly detail: string; readonly kind: string };

export function MemoryPanel({
  companyId,
  role,
  initialItems,
  listRefusal,
  capped,
  pageSize,
}: {
  companyId: string;
  role: string;
  initialItems: readonly MemoryItemDTO[] | null;
  listRefusal: string | null;
  capped: boolean;
  /**
   * The server's own list limit, PASSED DOWN rather than imported. This is a client module, and importing
   * `MEMORY_LIST_DEFAULT_LIMIT` from `@acbp/core` here would drag the whole server composition graph —
   * `@clerk/backend`, `pg`, the repositories, the authz matrix — across the client boundary. Every other
   * `'use client'` file in this app imports only the zero-dependency `@acbp/contracts`, and this keeps that
   * true. A hardcoded literal would be the other wrong answer: it would silently stop matching the server
   * the day the limit changed, and the screen would then claim a complete history it no longer had.
   */
  pageSize: number;
}): React.JSX.Element {
  const router = useRouter();
  const [items, setItems] = useState<readonly MemoryItemDTO[] | null>(initialItems);
  const [isCapped, setIsCapped] = useState(capped);
  const [editing, setEditing] = useState<MemoryRowView | null>(null);
  const [confirming, setConfirming] = useState<MemoryRowView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<RowOutcome | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  const base = `/api/companies/${encodeURIComponent(companyId)}/memory`;
  const view = toMemoryView(items, role, isCapped);
  const announcement = describeMemory(view);
  const lastAnnounced = useRef<string>('');
  const changed = announcement !== lastAnnounced.current;
  if (changed) lastAnnounced.current = announcement;

  const reload = useCallback(async (): Promise<void> => {
    try {
      // No query string — see the header.
      const res = await fetch(base, { headers: { accept: 'application/json' } });
      const text = await res.text();
      const out = interpretListResponse(res.status, text, res.headers.get('retry-after'));
      if (out.kind === 'items') {
        setItems(out.items);
        setIsCapped(out.items.length >= pageSize);
        setReadError(null);
      } else {
        // A failed re-read does NOT clear the list: what is shown stays, flagged as possibly stale. Nulling
        // it would turn a read failure into an assertion that nothing is stored.
        setReadError(out.detail);
      }
    } catch {
      setReadError('The list could not be re-read just now, so what is shown may be out of date.');
    }
  }, [base, pageSize]);

  async function submitEdit(row: MemoryRowView, type: MemoryType, content: string): Promise<void> {
    if (busyId !== null) return;
    setBusyId(row.memoryItemId);
    setOutcome(null);
    try {
      // A FULL REPLACE, not a partial patch despite the verb: the server writes `confidence` from what is
      // sent, so an existing score is cleared either way. `null` is sent explicitly rather than omitted so
      // the request states what it means, and the form says so out loud — a sentence this comment claimed
      // existed before review pointed out that it did not.
      const res = await fetch(`${base}/${encodeURIComponent(row.memoryItemId)}`, {
        method: 'PATCH',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ type, content, confidence: null }),
      });
      const text = await res.text();
      const result: EditOutcome = interpretEditResponse(res.status, text, res.headers.get('retry-after'));
      setOutcome({ memoryItemId: row.memoryItemId, detail: result.kind === 'invalid' ? `${result.serverMessage} ${result.detail}` : result.detail, kind: result.kind });
      if (result.kind === 'saved') setEditing(null);
      await reload();
      router.refresh();
    } catch {
      setOutcome({ memoryItemId: row.memoryItemId, detail: 'The edit did not reach the server, or the reply was lost. Nothing has been assumed about whether it saved — the list has been re-read.', kind: 'error' });
      await reload();
    } finally {
      setBusyId(null);
    }
  }

  async function submitDelete(row: MemoryRowView): Promise<void> {
    if (busyId !== null) return;
    setBusyId(row.memoryItemId);
    setOutcome(null);
    try {
      // Bodiless — no content-type.
      const res = await fetch(`${base}/${encodeURIComponent(row.memoryItemId)}`, { method: 'DELETE', headers: { accept: 'application/json' } });
      const text = await res.text();
      const result: DeleteOutcome = interpretDeleteResponse(res.status, text, res.headers.get('retry-after'));
      setOutcome({ memoryItemId: row.memoryItemId, detail: result.detail, kind: result.kind });
      setConfirming(null);
      await reload();
      router.refresh();
    } catch {
      setOutcome({ memoryItemId: row.memoryItemId, detail: 'The request did not reach the server, or the reply was lost. Nothing has been assumed about whether the item was removed — the list has been re-read.', kind: 'error' });
      setConfirming(null);
      await reload();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="cs-card" aria-labelledby="cs-mem-h">
      <div className="cs-card-h">
        <h2 className="cs-card-t" id="cs-mem-h">
          Stored items
        </h2>
        {view.itemsState === 'has_items' ? <span className="cs-badge cs-badge--muted">{view.totalShown} shown</span> : null}
      </div>

      {/* Polite and sr-only: the counts are already visible above. A SEPARATE node from the table, because
          a live region whose children re-render wholesale frequently announces nothing at all. */}
      <p aria-live="polite" className="cs-sr-only" data-announcement={changed ? 'changed' : 'same'}>
        {announcement}
      </p>

      {/*
        ONE PERSISTENT REGION FOR EVERY OUTCOME, and the delete verb is why it cannot live in the table row.
        The first version keyed each outcome to its row and rendered it inside that row — which works for an
        edit (the item is superseded, so it stays in the list) and silently DESTROYS the answer for a delete,
        because the reload that follows removes the row the notice was attached to. The 200 "removed, record
        retained", the 404 "nothing was there" and the 409 "state changed" then rendered IDENTICALLY: row
        gone, count decremented, no sentence. Two of those are the server saying nothing was removed while
        the screen implied it was.

        It is also always mounted, empty or not: a live region added to the DOM at the same moment as its
        text is frequently not announced at all.
      */}
      <div aria-live="polite" className="cs-outcome-region">
        {readError === null ? null : (
          <p className="cs-control-outcome cs-control-outcome--error" role="status">
            {readError}
          </p>
        )}
        {outcome === null ? null : (
          <p className={`cs-control-outcome cs-control-outcome--${outcome.kind}`} role="status" data-outcome={outcome.kind}>
            {outcome.detail}
          </p>
        )}
      </div>

      {view.itemsState === 'unknown' ? (
        <p className="cs-control-outcome cs-control-outcome--refused" role="status">
          The memory list has not been read{listRefusal === null ? '' : <> (the server answered <strong>{listRefusal}</strong>)</>}, so nothing is shown. This is NOT the same as there being no memory items —
          nothing is known either way until a read succeeds.
        </p>
      ) : view.itemsState === 'none_exist' ? (
        // SAYS ONLY WHAT AN EMPTY 200 ACTUALLY MEANS. The first version added "so an empty list here means
        // nothing has been recorded, not that anything was lost" — a contrastive claim that ruled out the
        // exact thing this screen does. Deleting the last item empties the list, because the server omits
        // deleted rows entirely, so that sentence would have been read one action after a founder deleted
        // something. The list being empty is not evidence that nothing was ever stored.
        <p className="cs-help">
          The server returned no memory items for this company. Items are written as the platform learns — from interview answers and from work it does — and deleted items are not listed here, so an empty list
          does not by itself say whether anything was ever recorded.
        </p>
      ) : (
        <>
          {view.capped ? (
            <p className="cs-help cs-mem-cap">
              Showing the newest {view.totalShown}. The server sends no total and no way to page further, so there may be more items than are listed here — and where an item shows no earlier version, that may be
              because the earlier version is outside this page rather than because none exists.
            </p>
          ) : null}
          {/* Opening one form closes the other: they are in flow and trap nothing, so leaving both open
              would leave two live forms competing for the same row. */}
          <MemoryTable
            rows={view.rows}
            busyId={busyId}
            onEdit={(r) => {
              setConfirming(null);
              setEditing(r);
            }}
            onDelete={(r) => {
              setEditing(null);
              setConfirming(r);
            }}
          />
        </>
      )}

      {/* `key` is load-bearing: EditDialog seeds its type/content from `useState` initialisers, which run
          ONCE per instance. Without a key, switching from one row to another re-renders the same instance,
          leaving the previous row's text in the form while the save submits against the new row's id. */}
      {editing === null ? null : <EditDialog key={editing.memoryItemId} row={editing} busy={busyId === editing.memoryItemId} onCancel={() => setEditing(null)} onSave={(t, c) => void submitEdit(editing, t, c)} />}
      {confirming === null ? null : <DeleteDialog key={confirming.memoryItemId} row={confirming} busy={busyId === confirming.memoryItemId} onCancel={() => setConfirming(null)} onConfirm={() => void submitDelete(confirming)} />}
    </section>
  );
}

function MemoryTable({
  rows,
  busyId,
  onEdit,
  onDelete,
}: {
  rows: readonly MemoryRowView[];
  busyId: string | null;
  onEdit: (r: MemoryRowView) => void;
  onDelete: (r: MemoryRowView) => void;
}): React.JSX.Element {
  return (
    // Scrolls rather than truncating, per the row's responsive criterion. The wrapper is focusable so a
    // keyboard user can reach the scroll region without a pointer.
    <div className="cs-table-scroll" tabIndex={0} role="region" aria-label="Stored memory items">
      <table className="cs-table">
        <caption className="cs-sr-only">Memory items, newest first. Each row shows its content, type, where it came from, and its version.</caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Type</th>
            <th scope="col">Source</th>
            <th scope="col">Confidence</th>
            <th scope="col">Version</th>
            <th scope="col">Recorded</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.memoryItemId} data-lifecycle={r.lifecycle}>
              {/* The content cell is the ROW HEADER, per the row's accessibility criterion: it is what
                  identifies the row, so every other cell is read in relation to it. */}
              <th scope="row" className="cs-table-item">
                {r.content}
              </th>
              <td>{r.type}</td>
              {/* Provenance as TEXT. `sourceRef` is never a link: the server neither resolves nor validates
                  it, so rendering it as one would promise a destination that may not exist. */}
              <td>
                {r.sourceType}
                <span className="cs-table-ref">{r.sourceRef}</span>
              </td>
              <td>{r.confidenceLabel}</td>
              <td>
                {r.lifecycle === 'superseded' ? <span className="cs-badge cs-badge--muted">replaced</span> : <span className="cs-badge cs-badge--muted">current</span>}
                {r.previousVersionId !== null ? <span className="cs-table-ref">follows an earlier version</span> : r.historyKnown ? null : <span className="cs-table-ref">earlier versions unknown</span>}
              </td>
              <td>{r.createdAt}</td>
              <td>
                <div className="cs-control-row">
                  <RowButton label="Edit" row={r} state={r.edit} busy={busyId === r.memoryItemId} anyBusy={busyId !== null} onClick={() => onEdit(r)} />
                  <RowButton label="Delete" row={r} state={r.delete} busy={busyId === r.memoryItemId} anyBusy={busyId !== null} onClick={() => onDelete(r)} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A per-row control. Disabled with its reason as TEXT — never a title tooltip, which touch and keyboard cannot reach. */
// `anyBusy` disables every row's controls while ANY request is in flight, not just the row making it.
// The handlers open with a silent `if (busyId !== null) return;`, so without this a founder can click a
// second row's Delete, see the confirmation, press it, and have nothing happen with no explanation.
function RowButton({ label, row, state, busy, anyBusy, onClick }: { label: string; row: MemoryRowView; state: MemoryRowView['edit']; busy: boolean; anyBusy: boolean; onClick: () => void }): React.JSX.Element {
  const whyId = `cs-mem-why-${label.toLowerCase()}-${row.memoryItemId}`;
  // The accessible name names the ITEM, not just the verb: a table of identical "Delete" buttons gives a
  // screen-reader user no way to tell which row they are on.
  const accessibleName = `${label} memory item: ${row.content.slice(0, 60)}`;
  if (state.kind === 'unavailable') {
    return (
      <span className="cs-control">
        <button type="button" className="cs-btn" disabled aria-label={accessibleName} aria-describedby={whyId}>
          {label}
        </button>
        <span className="cs-control-why" id={whyId} data-because={state.because}>
          {state.reason}
        </span>
      </span>
    );
  }
  return (
    <button type="button" className={label === 'Delete' ? 'cs-btn cs-btn--danger' : 'cs-btn'} onClick={onClick} disabled={anyBusy} aria-busy={busy} aria-label={accessibleName}>
      {label}
    </button>
  );
}

function EditDialog({ row, busy, onCancel, onSave }: { row: MemoryRowView; busy: boolean; onCancel: () => void; onSave: (t: MemoryType, c: string) => void }): React.JSX.Element {
  const [type, setType] = useState<MemoryType>(row.type);
  const [content, setContent] = useState(row.content);
  // Matches the SERVER's rule: content is not trimmed, and emptiness is checked on the raw string.
  const canSave = content.length > 0 && content.length <= MEMORY_CONTENT_MAX;
  return (
    // NOT `role="dialog" aria-modal="true"`. This console has no focus-trap primitive: nothing moves focus
    // in, nothing keeps it in, nothing marks the rest of the page inert, and no Escape handler exists. A
    // modal that traps nothing while announcing itself as modal tells assistive technology the rest of the
    // page is unavailable when it is fully reachable — worse than a form that simply sits in the page,
    // which is what this is. It is a labelled region instead, which is true.
    <section className="cs-dialog" aria-labelledby="cs-mem-edit-t">
      <h3 className="cs-card-t" id="cs-mem-edit-t">
        Edit this memory item
      </h3>
      <p className="cs-help">
        Saving records a NEW version rather than overwriting this one. The current text stays in the list, marked as replaced, and the new version is recorded as coming from you — its source becomes
        <strong> user_edit</strong>, replacing where it originally came from.
      </p>
      <fieldset className="cs-field" disabled={busy}>
        <legend className="cs-label">Type</legend>
        <select className="cs-input" value={type} onChange={(e) => setType(e.target.value as MemoryType)} aria-label="Memory item type">
          {MEMORY_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </fieldset>
      <fieldset className="cs-field" disabled={busy}>
        <legend className="cs-label">Content</legend>
        <textarea className="cs-input cs-textarea" value={content} onChange={(e) => setContent(e.target.value)} rows={5} aria-label="Memory item content" aria-describedby="cs-mem-content-help" />
        <p className="cs-help" id="cs-mem-content-help">
          {content.length} of {MEMORY_CONTENT_MAX} characters. The server’s limit is measured in bytes as well as characters, so text in a non-Latin script can be refused before this count runs out.
        </p>
      </fieldset>
      {/* THE DISCLOSURE THE CODE'S OWN COMMENT PROMISED. Saving sends `confidence: null`, because PATCH is a
          full replace and this form collects no score — so any existing score is cleared. The comment beside
          the request said the form "says so"; until review pointed it out, it did not. */}
      <p className="cs-help">This form does not collect a confidence score, and saving records the new version without one. If this item had a score, it will not carry over.</p>
      <div className="cs-control-row">
        <button type="button" className="cs-btn cs-btn--primary" onClick={() => onSave(type, content)} disabled={!canSave || busy} aria-busy={busy}>
          {busy ? 'Saving…' : 'Save as a new version'}
        </button>
        <button type="button" className="cs-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </section>
  );
}

function DeleteDialog({ row, busy, onCancel, onConfirm }: { row: MemoryRowView; busy: boolean; onCancel: () => void; onConfirm: () => void }): React.JSX.Element {
  return (
    // A labelled region, not an `aria-modal` dialog — see the note on the edit form.
    <section className="cs-dialog cs-dialog--danger" aria-labelledby="cs-mem-del-t">
      <h3 className="cs-card-t" id="cs-mem-del-t">
        Delete this memory item?
      </h3>
      {/* NAMES THE TARGET. The first version was entirely generic, and because these forms sit in flow
          BELOW the table, a founder could be reading a confirmation hundreds of pixels from the row that
          opened it with nothing on screen tying the two together. A destructive confirmation that does not
          say what it will destroy is not a confirmation. */}
      <p className="cs-refusal-detail cs-dialog-target">{row.content}</p>
      {/* Every clause below is enforced by something nameable — see the file header. The words
          "permanently", "erase" and "gone forever" are absent because each would be false. */}
      <p className="cs-refusal-detail">
        This removes the current version from this browser. <strong>You cannot undo it here</strong> — the platform has no restore, and no other screen can bring it back.
      </p>
      {/* SAYS ONLY THAT THE RECORD IS RETAINED. An earlier draft added "and it still appears in your data
          export" — true of the stored row, but it names a document a founder has no way to obtain: nothing
          under apps/web references the export use case, and no route or screen exposes it. Offering it as
          the reassurance that this is not an erasure would have pointed at a door that does not open. */}
      <p className="cs-refusal-detail">It is not an erasure. The record is retained for the platform’s audit trail, and this action is itself recorded.</p>
      <p className="cs-refusal-detail">
        From now on this item will not be used as context for anything the platform generates. It does <strong>not</strong> change anything already generated — your understanding, strategy and plans are
        unaffected.
      </p>
      {/* ONLY when a predecessor is actually known. The earlier condition also fired whenever the page was
          full, which is precisely the state in which the screen has recorded that it CANNOT see the chain —
          so it asserted that earlier versions are visible exactly when it did not know that. */}
      {row.previousVersionId !== null ? <p className="cs-refusal-detail">This item has an earlier version, which stays visible in this browser and cannot be removed.</p> : null}
      <div className="cs-control-row">
        <button type="button" className="cs-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="cs-btn cs-btn--danger" onClick={onConfirm} disabled={busy} aria-busy={busy}>
          {busy ? 'Deleting…' : 'Delete this version'}
        </button>
      </div>
    </section>
  );
}
