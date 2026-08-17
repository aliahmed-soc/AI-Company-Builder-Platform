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
 *   - but not an erasure — it is a soft delete; the row and its content are retained, and the item still
 *     appears in the founder's own data export, which is where a "permanently deleted" claim would be
 *     caught being false;
 *   - it does remove the item from future generated context;
 *   - it retracts nothing already generated;
 *   - and earlier versions stay visible and cannot themselves be deleted.
 * The words "permanently", "erase", "gone forever" and "wiped" are therefore absent by design.
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
}: {
  companyId: string;
  role: string;
  initialItems: readonly MemoryItemDTO[] | null;
  listRefusal: string | null;
  capped: boolean;
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
        setIsCapped(out.items.length >= 100);
        setReadError(null);
      } else {
        // A failed re-read does NOT clear the list: what is shown stays, flagged as possibly stale. Nulling
        // it would turn a read failure into an assertion that nothing is stored.
        setReadError(out.detail);
      }
    } catch {
      setReadError('The list could not be re-read just now, so what is shown may be out of date.');
    }
  }, [base]);

  async function submitEdit(row: MemoryRowView, type: MemoryType, content: string): Promise<void> {
    if (busyId !== null) return;
    setBusyId(row.memoryItemId);
    setOutcome(null);
    try {
      // A FULL REPLACE, not a partial patch despite the verb: the server writes `confidence` from what is
      // sent, so omitting it would silently null a score. This screen never sets one, and says so in the
      // form rather than sending a value it did not collect.
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

      <div aria-live="polite" className="cs-outcome-region">
        {readError === null ? null : (
          <p className="cs-control-outcome cs-control-outcome--error" role="status">
            {readError}
          </p>
        )}
      </div>

      {view.itemsState === 'unknown' ? (
        <p className="cs-control-outcome cs-control-outcome--refused" role="status">
          The memory list has not been read{listRefusal === null ? '' : <> (the server answered <strong>{listRefusal}</strong>)</>}, so nothing is shown. This is NOT the same as there being no memory items —
          nothing is known either way until a read succeeds.
        </p>
      ) : view.itemsState === 'none_exist' ? (
        <p className="cs-help">
          There are no memory items stored for this company yet. Items are written as the platform learns — from interview answers and from work it does — so an empty list here means nothing has been recorded,
          not that anything was lost.
        </p>
      ) : (
        <>
          {view.capped ? (
            <p className="cs-help cs-mem-cap">
              Showing the newest {view.totalShown}. The server sends no total and no way to page further, so there may be more items than are listed here — and where an item shows no earlier version, that may be
              because the earlier version is outside this page rather than because none exists.
            </p>
          ) : null}
          <MemoryTable rows={view.rows} busyId={busyId} outcome={outcome} onEdit={setEditing} onDelete={setConfirming} />
        </>
      )}

      {editing === null ? null : <EditDialog row={editing} busy={busyId === editing.memoryItemId} onCancel={() => setEditing(null)} onSave={(t, c) => void submitEdit(editing, t, c)} />}
      {confirming === null ? null : <DeleteDialog row={confirming} busy={busyId === confirming.memoryItemId} onCancel={() => setConfirming(null)} onConfirm={() => void submitDelete(confirming)} />}
    </section>
  );
}

function MemoryTable({
  rows,
  busyId,
  outcome,
  onEdit,
  onDelete,
}: {
  rows: readonly MemoryRowView[];
  busyId: string | null;
  outcome: RowOutcome | null;
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
                {outcome?.memoryItemId === r.memoryItemId ? (
                  <span className={`cs-control-outcome cs-control-outcome--${outcome.kind} cs-table-outcome`} role="status">
                    {outcome.detail}
                  </span>
                ) : null}
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
                  <RowButton label="Edit" row={r} state={r.edit} busy={busyId === r.memoryItemId} onClick={() => onEdit(r)} />
                  <RowButton label="Delete" row={r} state={r.delete} busy={busyId === r.memoryItemId} onClick={() => onDelete(r)} />
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
function RowButton({ label, row, state, busy, onClick }: { label: string; row: MemoryRowView; state: MemoryRowView['edit']; busy: boolean; onClick: () => void }): React.JSX.Element {
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
    <button type="button" className={label === 'Delete' ? 'cs-btn cs-btn--danger' : 'cs-btn'} onClick={onClick} disabled={busy} aria-busy={busy} aria-label={accessibleName}>
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
    <div className="cs-dialog" role="dialog" aria-modal="true" aria-labelledby="cs-mem-edit-t">
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
        <textarea className="cs-input cs-textarea" value={content} onChange={(e) => setContent(e.target.value)} rows={5} aria-label="Memory item content" />
        <p className="cs-help">
          {content.length} of {MEMORY_CONTENT_MAX} characters. The server’s limit is measured in bytes as well as characters, so text in a non-Latin script can be refused before this count runs out.
        </p>
      </fieldset>
      <div className="cs-control-row">
        <button type="button" className="cs-btn cs-btn--primary" onClick={() => onSave(type, content)} disabled={!canSave || busy} aria-busy={busy}>
          {busy ? 'Saving…' : 'Save as a new version'}
        </button>
        <button type="button" className="cs-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function DeleteDialog({ row, busy, onCancel, onConfirm }: { row: MemoryRowView; busy: boolean; onCancel: () => void; onConfirm: () => void }): React.JSX.Element {
  return (
    <div className="cs-dialog cs-dialog--danger" role="dialog" aria-modal="true" aria-labelledby="cs-mem-del-t">
      <h3 className="cs-card-t" id="cs-mem-del-t">
        Delete this memory item?
      </h3>
      {/* Every clause below is enforced by something nameable — see the file header. The words
          "permanently", "erase" and "gone forever" are absent because each would be false. */}
      <p className="cs-refusal-detail">
        This removes the current version from this browser. <strong>You cannot undo it here</strong> — the platform has no restore, and no other screen can bring it back.
      </p>
      <p className="cs-refusal-detail">It is not an erasure. The record is retained for the audit trail, and it still appears in your data export.</p>
      <p className="cs-refusal-detail">
        From now on this item will not be used as context for anything the platform generates. It does <strong>not</strong> change anything already generated — your understanding, strategy and plans are
        unaffected.
      </p>
      {row.previousVersionId !== null || !row.historyKnown ? <p className="cs-refusal-detail">Earlier versions of this item stay visible in this browser and cannot be removed.</p> : null}
      <div className="cs-control-row">
        <button type="button" className="cs-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="cs-btn cs-btn--danger" onClick={onConfirm} disabled={busy} aria-busy={busy}>
          {busy ? 'Deleting…' : 'Delete this version'}
        </button>
      </div>
    </div>
  );
}
