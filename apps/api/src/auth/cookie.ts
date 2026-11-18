export const SESSION_COOKIE = "__Host-shoutory_session";

// The library mints a session token with 32 alphanumeric characters, never a colon. The stored form (`h1:` and a
// digest) is passed through by the token wrapper, so a client must never be able to present it.
const TOKEN_SHAPE = /^[A-Za-z0-9]{32}$/;

function wellFormed(value: string): boolean {
  try {
    return TOKEN_SHAPE.test(decodeURIComponent(value).split(".")[0] ?? "");
  } catch (error) {
    if (error instanceof URIError) return false;
    throw error;
  }
}

/**
 * The request headers with a session cookie whose token part is not the library's shape removed, so the cookie counts
 * as absent: a `session` route answers 401, a public route is served without it. The one place a client token enters.
 */
export function withoutForgedSession(headers: Headers): Headers {
  const cookie = headers.get("cookie");
  if (cookie === null) return headers;
  const kept = cookie.split(";").filter((pair) => {
    const [name = "", ...rest] = pair.trim().split("=");
    return name !== SESSION_COOKIE || wellFormed(rest.join("="));
  });
  const clean = new Headers(headers);
  if (kept.length === 0) clean.delete("cookie");
  else clean.set("cookie", kept.map((pair) => pair.trim()).join("; "));
  return clean;
}

/** The cookie that holds a second-factor challenge between the password and the code; ten minutes (the plugin's). */
export const TWO_FACTOR_COOKIE = "__Host-shoutory_two_factor";

/** Only our two cookies leave a library answer: it also expires cookies of features we do not use. */
export const authCookies = (headers: Headers): string[] =>
  headers
    .getSetCookie()
    .filter((line) => line.startsWith(`${SESSION_COOKIE}=`) || line.startsWith(`${TWO_FACTOR_COOKIE}=`));

/** Only the session cookie: what a session check forwards. */
export const sessionCookies = (headers: Headers): string[] =>
  headers.getSetCookie().filter((line) => line.startsWith(`${SESSION_COOKIE}=`));

/** The session cookie line that sets a session (a non-empty value), if the answer carries one. */
export const liveSessionCookie = (lines: readonly string[]): string | undefined =>
  lines.find((line) => new RegExp(`^${SESSION_COOKIE}=[^;]`).test(line));
