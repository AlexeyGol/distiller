/**
 * The shape every Server Action returns to useActionState.
 *
 * It lives outside the "use server" module on purpose: those may only export
 * async functions, so a shared constant cannot be declared there.
 */
export interface ActionState {
  ok: boolean;
  message: string;
}

export const EMPTY_STATE: ActionState = { ok: true, message: "" };
