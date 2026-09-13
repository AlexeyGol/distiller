import type { Metadata } from "next";
import Link from "next/link";
import { PlayerProvider } from "../components/Player.js";
import { appPassword, warnIfAuthDisabled } from "../lib/auth.js";
import { logoutAction } from "./actions.js";
import "./globals.css";

export const metadata: Metadata = {
  title: "Distiller",
  description: "RSS and YouTube into a podcast digest",
};

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/topics", label: "Topics" },
  { href: "/sources", label: "Sources" },
  { href: "/digests", label: "Digests" },
  { href: "/settings", label: "Settings" },
];

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const password = appPassword();
  warnIfAuthDisabled(password);

  return (
    <html lang="en">
      <body>
        <PlayerProvider>
          <header className="topbar">
            <Link href="/" className="brand">
              Distiller
            </Link>
            <nav>
              {NAV.map((entry) => (
                <Link key={entry.href} href={entry.href}>
                  {entry.label}
                </Link>
              ))}
            </nav>
            {password ? (
              <form action={logoutAction}>
                <button type="submit" className="btn plain">
                  Log out
                </button>
              </form>
            ) : (
              <span className="warn-pill" title="APP_PASSWORD is not set">
                auth disabled
              </span>
            )}
          </header>
          <main>{children}</main>
        </PlayerProvider>
      </body>
    </html>
  );
}
