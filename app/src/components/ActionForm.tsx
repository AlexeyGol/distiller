"use client";

import { useActionState, type ReactNode } from "react";
import { EMPTY_STATE, type ActionState } from "../lib/action-state.js";

export type FormAction = (
  prev: ActionState,
  form: FormData,
) => Promise<ActionState>;

export interface ActionFormProps {
  action: FormAction;
  submitLabel: string;
  children?: ReactNode;
  className?: string;
  /** Rendered beside the submit button, e.g. a secondary action. */
  extra?: ReactNode;
  variant?: "primary" | "danger" | "plain";
}

/**
 * A form bound to a Server Action, with the pending state and the result
 * message handled once instead of in every page. The inputs themselves stay
 * server-rendered and are passed in as children.
 */
export function ActionForm({
  action,
  submitLabel,
  children,
  className,
  extra,
  variant = "primary",
}: ActionFormProps) {
  const [state, formAction, pending] = useActionState(action, EMPTY_STATE);

  return (
    <form action={formAction} className={className}>
      {children}
      <div className="row">
        <button type="submit" className={`btn ${variant}`} disabled={pending}>
          {pending ? "Working..." : submitLabel}
        </button>
        {extra}
      </div>
      {state.message ? (
        <p className={state.ok ? "ok-msg" : "err-msg"}>{state.message}</p>
      ) : null}
    </form>
  );
}
