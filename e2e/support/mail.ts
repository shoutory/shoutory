const WAIT_MS = 60_000;
const POLL_MS = 500;
const LINK = /https?:\/\/[^\s<>"]+/g;

interface Found {
  readonly messages?: ReadonlyArray<{ readonly ID: string }>;
}

async function getJson<T>(url: string): Promise<T> {
  const answer = await fetch(url);
  if (!answer.ok) throw new Error(`the mail catcher answered ${answer.status} for ${new URL(url).pathname}`);
  return (await answer.json()) as T;
}

async function linkIn(base: string, id: string, path: string): Promise<string | undefined> {
  const { Text } = await getJson<{ Text: string }>(`${base}/api/v1/message/${id}`);
  return (Text.match(LINK) ?? []).find((link) => new URL(link).pathname.includes(path));
}

/**
 * Waits for a message to `to` that carries a link whose path contains `path`, and returns that link. A link in `skip`
 * is one the caller already used, so a second invitation to the same address finds its own.
 */
export async function waitForLink({
  to,
  path,
  skip = [],
}: {
  to: string;
  path: string;
  skip?: readonly string[];
}): Promise<string> {
  const base = process.env.SHOUTORY_E2E_MAIL_URL;
  if (!base) throw new Error("the stack has not published its mail catcher address");
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const found = await getJson<Found>(`${base}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
    for (const { ID } of found.messages ?? []) {
      const link = await linkIn(base, ID, path);
      if (link && !skip.includes(link)) return link;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`no mail to ${to} with a ${path} link arrived in ${WAIT_MS / 1000} seconds`);
}
