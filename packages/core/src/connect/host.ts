const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;
const MAX_HOST = 253;
const MAX_LABEL = 63;

const validName = (host: string): boolean => {
  const labels = host.split(".");
  return (
    host.length <= MAX_HOST &&
    labels.length > 1 &&
    !IPV4.test(host) &&
    labels.every((label) => label.length <= MAX_LABEL && LABEL.test(label))
  );
};

/**
 * The one stored form of an instance host a person typed: lower case, punycode, no scheme, path, port 443 or trailing
 * dot. Another scheme, userinfo, another port, an IP literal or a name with no dot is no host.
 */
export function normalizeInstanceHost(input: string): string | undefined {
  const typed = input.trim().toLowerCase();
  const rest = typed.startsWith("https://") ? typed.slice("https://".length) : typed;
  if (rest === "" || rest.includes("://")) return undefined;
  // The WHATWG parser converts an IDN to punycode, reads a numeric name as IPv4 and drops the https default port.
  const url = URL.parse(`https://${rest}`);
  if (url === null || `${url.username}${url.password}${url.port}` !== "") return undefined;
  const host = url.hostname.replace(/\.$/, "");
  return validName(host) ? host : undefined;
}
