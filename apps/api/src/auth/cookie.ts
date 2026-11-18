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

/** Only the session cookie leaves a library answer: it also expires cookies of features we do not use. */
export const sessionCookies = (headers: Headers): string[] =>
  headers.getSetCookie().filter((line) => line.startsWith(`${SESSION_COOKIE}=`));
