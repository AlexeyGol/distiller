"use client";

import { useActionState, useState } from "react";
import { EMPTY_STATE } from "../lib/action-state.js";
import type { FormAction } from "./ActionForm.js";

export interface CurationItem {
  id: string;
  title: string;
  url: string;
  /** Preformatted on the server: a raw Date would hydrate differently. */
  published: string;
  sourceLabel: string;
  included: boolean;
  excerpt: string | null;
}

export interface CurationListProps {
  digestId: string;
  items: CurationItem[];
  /** Only a draft can be curated; later states show the outcome read-only. */
  editable: boolean;
  saveAction: FormAction;
  approveAction: FormAction;
}

/**
 * The curation gate. Rendering is quota-limited, so a human decides what goes
 * in before anything is spent; Approve is disabled while the selection is
 * empty, which is the same rule the pipeline enforces server-side.
 */
export function CurationList({
  digestId,
  items,
  editable,
  saveAction,
  approveAction,
}: CurationListProps) {
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(items.filter((item) => item.included).map((item) => item.id)),
  );
  const [saveState, save, saving] = useActionState(saveAction, EMPTY_STATE);
  const [approveState, approve, approving] = useActionState(
    approveAction,
    EMPTY_STATE,
  );

  function toggle(id: string, next: boolean) {
    setChecked((previous) => {
      const copy = new Set(previous);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  }

  const selected = checked.size;

  if (items.length === 0) {
    return <p className="muted">This digest has no candidate items.</p>;
  }

  return (
    <form action={save} className="stack">
      <input type="hidden" name="digestId" value={digestId} />

      <ul className="items">
        {items.map((item) => (
          <li key={item.id} className={checked.has(item.id) ? "" : "dimmed"}>
            <input type="hidden" name="item" value={item.id} />
            <label className="item-row">
              <input
                type="checkbox"
                name="include"
                value={item.id}
                checked={checked.has(item.id)}
                disabled={!editable}
                onChange={(event) => toggle(item.id, event.target.checked)}
              />
              <span className="item-body">
                <a href={item.url} target="_blank" rel="noreferrer">
                  {item.title}
                </a>
                <span className="muted item-meta">
                  {item.sourceLabel} - {item.published}
                </span>
                {item.excerpt ? (
                  <span className="excerpt">{item.excerpt}</span>
                ) : null}
              </span>
            </label>
          </li>
        ))}
      </ul>

      {editable ? (
        <div className="row">
          <button type="submit" className="btn plain" disabled={saving}>
            {saving ? "Saving..." : "Save selection"}
          </button>
          <button
            type="submit"
            className="btn primary"
            formAction={approve}
            disabled={approving || selected === 0}
            title={
              selected === 0
                ? "Select at least one item before approving"
                : undefined
            }
          >
            {approving ? "Approving..." : `Approve (${selected})`}
          </button>
        </div>
      ) : (
        <p className="muted">
          {selected} item(s) included. Curation is closed once a digest leaves
          draft.
        </p>
      )}

      {saveState.message ? (
        <p className={saveState.ok ? "ok-msg" : "err-msg"}>
          {saveState.message}
        </p>
      ) : null}
      {approveState.message ? (
        <p className={approveState.ok ? "ok-msg" : "err-msg"}>
          {approveState.message}
        </p>
      ) : null}
    </form>
  );
}
