/**
 * RCB-34/P7.3, plan §11 O6: the column set is a per-user choice, edited here instead of by hand
 * in `board.yml`. Removing a column never loses a card — a card whose status names no configured
 * column already renders under "not in board.yml" (`Column.tsx`, `store.ts#columnsWithCards`) —
 * so this panel does not need to touch cards at all, only the column list.
 *
 * `id` is read-only on an existing row: changing it would orphan every card already filed under
 * the old id with no way back through this panel. The fix for a bad id is remove + add, which is
 * why "Add column" is a separate small form rather than an inline edit of the id field.
 */
import type { BoardConfig, Card, Column } from '@repoboard/core';
import { useState } from 'react';

interface Props {
  config: BoardConfig;
  cards: Card[];
  onSave: (columns: Column[]) => Promise<boolean>;
}

const ID_PATTERN = /^[a-z0-9_-]+$/;

function setField<K extends keyof Column>(
  columns: Column[],
  index: number,
  key: K,
  value: Column[K] | undefined,
): Column[] {
  return columns.map((col, i) => {
    if (i !== index) return col;
    const next = { ...col };
    if (value === undefined) delete next[key];
    else next[key] = value;
    return next;
  });
}

function move(columns: Column[], index: number, dir: -1 | 1): Column[] {
  const target = index + dir;
  if (target < 0 || target >= columns.length) return columns;
  const next = [...columns];
  [next[index], next[target]] = [next[target] as Column, next[index] as Column];
  return next;
}

export function ColumnEditor({ config, cards, onSave }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Column[]>(config.columns);
  const [saving, setSaving] = useState(false);
  const [newId, setNewId] = useState('');
  const [newTitle, setNewTitle] = useState('');

  const openPanel = () => {
    setDraft(config.columns);
    setNewId('');
    setNewTitle('');
    setOpen(true);
  };
  const cancel = () => setOpen(false);

  const save = async () => {
    setSaving(true);
    const ok = await onSave(draft);
    setSaving(false);
    if (ok) setOpen(false);
  };

  const countFor = (id: string) => cards.filter((c) => c.status === id).length;

  const trimmedNewId = newId.trim();
  const idValid = ID_PATTERN.test(trimmedNewId) && !draft.some((c) => c.id === trimmedNewId);

  const addColumn = () => {
    if (!idValid) return;
    const title = newTitle.trim();
    const column: Column = title ? { id: trimmedNewId, title } : { id: trimmedNewId };
    setDraft([...draft, column]);
    setNewId('');
    setNewTitle('');
  };

  if (!open) {
    return (
      <button type="button" className="column-editor-toggle" onClick={openPanel}>
        Columns…
      </button>
    );
  }

  return (
    <div className="column-editor" data-testid="column-editor">
      <p className="column-editor__note">
        Saving rewrites <code>.repoboard/board.yml</code>; comments in it are dropped. Cards in a
        removed column stay on disk and show under "not in board.yml".
      </p>
      <table className="column-editor__table">
        <thead>
          <tr>
            <th>id</th>
            <th>title</th>
            <th>active</th>
            <th>done</th>
            <th>decision</th>
            <th>wip</th>
            <th>cards</th>
            <th>{/* move / remove actions */}</th>
          </tr>
        </thead>
        <tbody>
          {draft.map((col, i) => (
            <tr key={col.id}>
              <td>{col.id}</td>
              <td>
                <input
                  type="text"
                  aria-label={`title for ${col.id}`}
                  value={col.title ?? ''}
                  disabled={saving}
                  onChange={(e) => {
                    const value = e.target.value.trim();
                    setDraft(setField(draft, i, 'title', value === '' ? undefined : value));
                  }}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  aria-label={`active for ${col.id}`}
                  checked={col.active === true}
                  disabled={saving}
                  onChange={(e) =>
                    setDraft(setField(draft, i, 'active', e.target.checked ? true : undefined))
                  }
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  aria-label={`done for ${col.id}`}
                  checked={col.done === true}
                  disabled={saving}
                  onChange={(e) =>
                    setDraft(setField(draft, i, 'done', e.target.checked ? true : undefined))
                  }
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  aria-label={`decision for ${col.id}`}
                  checked={col.decision === true}
                  disabled={saving}
                  onChange={(e) =>
                    setDraft(setField(draft, i, 'decision', e.target.checked ? true : undefined))
                  }
                />
              </td>
              <td>
                <input
                  type="number"
                  min={1}
                  step={1}
                  aria-label={`wip for ${col.id}`}
                  value={col.wip ?? ''}
                  disabled={saving}
                  onChange={(e) => {
                    const raw = e.target.value;
                    const n = raw === '' ? undefined : Number(raw);
                    setDraft(
                      setField(draft, i, 'wip', n === undefined || Number.isNaN(n) ? undefined : n),
                    );
                  }}
                />
              </td>
              <td className="column-editor__count">{countFor(col.id)}</td>
              <td className="column-editor__row-actions">
                <button
                  type="button"
                  aria-label={`move ${col.id} up`}
                  disabled={saving || i === 0}
                  onClick={() => setDraft(move(draft, i, -1))}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`move ${col.id} down`}
                  disabled={saving || i === draft.length - 1}
                  onClick={() => setDraft(move(draft, i, 1))}
                >
                  ↓
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setDraft(draft.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="column-editor__add">
        <input
          type="text"
          placeholder="id"
          aria-label="new column id"
          value={newId}
          disabled={saving}
          onChange={(e) => setNewId(e.target.value)}
        />
        <input
          type="text"
          placeholder="title"
          aria-label="new column title"
          value={newTitle}
          disabled={saving}
          onChange={(e) => setNewTitle(e.target.value)}
        />
        <button type="button" disabled={saving || !idValid} onClick={addColumn}>
          Add column
        </button>
      </div>
      <div className="column-editor__actions">
        <button type="button" disabled={saving} onClick={save}>
          Save
        </button>
        <button type="button" disabled={saving} onClick={cancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
