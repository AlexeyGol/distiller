import { redirect } from "next/navigation";
import { ActionForm } from "../../components/ActionForm.js";
import { appPassword } from "../../lib/auth.js";
import { loginAction } from "../actions.js";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // With no password configured there is nothing to log in to; middleware is
  // already letting everything through, so a login form would just confuse.
  if (!appPassword()) redirect("/");

  const { next } = await searchParams;

  return (
    <div className="login card">
      <h1>Distiller</h1>
      <p className="muted">Enter the shared password to continue.</p>
      <ActionForm action={loginAction} submitLabel="Log in" className="stack">
        <input type="hidden" name="next" value={next ?? "/"} />
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            autoFocus
          />
        </div>
      </ActionForm>
    </div>
  );
}
