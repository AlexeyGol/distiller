import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  appPassword,
  isAuthorized,
  isPublicPath,
} from "./lib/auth.js";

/**
 * The auth gate. Every request that is not explicitly public must carry a
 * valid session cookie, including the artifact route: the audio files are as
 * sensitive as the pages that link to them.
 *
 * With APP_PASSWORD unset this lets everything through and warns on stderr.
 * That keeps `next dev` usable on a fresh checkout, and the warning is what
 * stops the open configuration from quietly reaching production.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (await isAuthorized(token, appPassword())) return NextResponse.next();

  const target = request.nextUrl.clone();
  target.pathname = "/login";
  target.search = pathname === "/" ? "" : `next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(target);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
