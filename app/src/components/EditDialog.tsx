"use client";

import { useRef, type ReactNode } from "react";

/**
 * A button that opens its children in a modal.
 *
 * Uses the native <dialog> element rather than a hand-rolled overlay:
 * showModal() gives focus trapping, Escape-to-close, inert background and the
 * top layer for free, which a div-based modal has to reimplement badly.
 *
 * The form inside is server-rendered and passed as children, so this component
 * stays the only client-side part and knows nothing about what it is editing.
 */
export interface EditDialogProps {
  /** Button text in the row. */
  triggerLabel: string;
  /** Heading inside the modal. */
  title: string;
  children: ReactNode;
}

export function EditDialog({ triggerLabel, title, children }: EditDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button
        type="button"
        className="btn link"
        onClick={() => ref.current?.showModal()}
      >
        {triggerLabel}
      </button>

      <dialog
        ref={ref}
        className="modal"
        // Clicking the backdrop closes. The check is on the dialog itself
        // because the backdrop is not a separate element to bind to.
        onClick={(event) => {
          if (event.target === ref.current) ref.current?.close();
        }}
      >
        <div className="modal-body">
          <div className="modal-head">
            <h3>{title}</h3>
            <button
              type="button"
              className="btn link"
              onClick={() => ref.current?.close()}
              aria-label="Close"
            >
              Close
            </button>
          </div>
          {children}
        </div>
      </dialog>
    </>
  );
}
