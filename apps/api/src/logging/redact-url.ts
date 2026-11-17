const UNPARSABLE = "[unparsable]";
const REDACTED = "REDACTED";
const PLACEHOLDER_BASE = "http://relative.invalid";
// A path segment after one of these carries a credential (compared after percent-decoding, case-insensitively).
const PATH_PREFIXES: ReadonlySet<string> = new Set([
  "share",
  "token",
  "verify",
  "reset",
  "invite",
  "unsubscribe",
  "signed",
]);
const QUERY_KEYS: ReadonlySet<string> = new Set([
  "token",
  "code",
  "key",
  "signature",
  "sig",
  "secret",
  "password",
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "api_key",
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-security-token",
]);

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment).toLowerCase();
  } catch (error) {
    if (error instanceof URIError) return segment.toLowerCase();
    throw error;
  }
}

function parse(raw: string): { url: URL; absolute: boolean } | undefined {
  if (URL.canParse(raw)) return { url: new URL(raw), absolute: true };
  const rooted = raw.startsWith("/") && !raw.startsWith("//");
  return rooted && URL.canParse(raw, PLACEHOLDER_BASE)
    ? { url: new URL(raw, PLACEHOLDER_BASE), absolute: false }
    : undefined;
}

/**
 * A URL or request target with credentials removed: userinfo and fragment dropped, credential query values and the
 * path after a credential prefix replaced. It never throws; a target it cannot parse becomes `[unparsable]`.
 */
export function redactUrl(raw: string): string {
  const parsed = parse(raw);
  if (!parsed) return UNPARSABLE;
  const { url, absolute } = parsed;
  url.username = "";
  url.password = "";
  url.hash = "";
  const segments = url.pathname.split("/");
  const cut = segments.findIndex((segment) => PATH_PREFIXES.has(decoded(segment)));
  if (cut >= 0 && cut < segments.length - 1)
    url.pathname = `${segments.slice(0, cut + 1).join("/")}/${REDACTED}`;
  for (const key of new Set(url.searchParams.keys())) {
    if (QUERY_KEYS.has(key.toLowerCase())) url.searchParams.set(key, REDACTED);
  }
  return absolute ? url.toString() : `${url.pathname}${url.search}`;
}
