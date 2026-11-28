import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { chromium, expect, test } from "@playwright/test";
import { simulatorBrowserArgs, simulators } from "../fixtures/simulators";
import { MASTODON_HOST } from "../fixtures/simulators-plan";
import { loadFounder } from "../support/journey";
import { APP_ORIGIN } from "../support/stack";

// One request to each host through the published port, with the name the adapters use as the TLS server name and the
// Host header, so the certificate and the routing by name are both read.
const PROBES = [
  { host: "api.telegram.org", method: "POST", path: "/bot0:none/getMe", status: 401, has: "Unauthorized" },
  { host: "discord.com", method: "GET", path: "/api/webhooks/1/none", status: 404, has: "Unknown Webhook" },
  {
    host: MASTODON_HOST,
    method: "GET",
    path: "/.well-known/oauth-authorization-server",
    status: 200,
    has: "S256",
  },
  { host: "alice.example", method: "GET", path: "/.well-known/atproto-did", status: 200, has: "did:plc:" },
  {
    host: "bob.example",
    method: "GET",
    path: "/.well-known/did.json",
    status: 200,
    has: "did:web:bob.example",
  },
  {
    host: "pds.example",
    method: "GET",
    path: "/.well-known/oauth-protected-resource",
    status: 200,
    has: "auth.example",
  },
  {
    host: "auth.example",
    method: "GET",
    path: "/.well-known/oauth-authorization-server",
    status: 200,
    has: "/oauth/par",
  },
  {
    host: "plc.directory",
    method: "GET",
    path: "/did:plc:alicealicealicealicealic",
    status: 200,
    has: "alsoKnownAs",
  },
] as const;

interface Reply {
  readonly status: number;
  readonly body: string;
}

function ask(probe: (typeof PROBES)[number], ca: Buffer | undefined): Promise<Reply> {
  const { port } = simulators();
  return new Promise((resolve, reject) => {
    const call = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        servername: probe.host,
        method: probe.method,
        path: probe.path,
        headers: { host: probe.host },
        ...(ca ? { ca } : {}),
      },
      (answer) => {
        const chunks: Buffer[] = [];
        answer.on("data", (chunk: Buffer) => chunks.push(chunk));
        answer.on("end", () =>
          resolve({ status: answer.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    call.on("error", reject);
    call.end();
  });
}

for (const probe of PROBES) {
  test(`${probe.host} answers over https from its own simulator, its certificate checked against the test CA`, async () => {
    const reply = await ask(probe, readFileSync(simulators().caPath));
    expect(reply.status).toBe(probe.status);
    expect(reply.body).toContain(probe.has);
  });
}

test("the test CA is what makes the certificate valid: without it the connection is refused", async () => {
  const [probe] = PROBES;
  await expect(ask(probe, undefined)).rejects.toThrow(/certificate|self.signed/i);
});

// A write from the page's own origin, as the app's cross-site check requires.
const WEB_CLIENT = { origin: APP_ORIGIN, "x-shoutory-client": "web" };

const connectPath = async (provider: string, action: string) =>
  `/api/v1/workspaces/${(await loadFounder()).workspace.id}/connect/${provider}/${action}`;

test("the app checks a bot token with the Telegram simulator over https: the simulator's own token is accepted and another is refused by it", async ({
  request,
}) => {
  const headers = WEB_CLIENT;
  const accepted = await request.post(await connectPath("telegram", "secret"), {
    headers,
    data: { secret: simulators().telegramToken },
  });
  expect(accepted.status()).toBe(200);
  expect(await accepted.json()).toMatchObject({ data: { challenge_id: expect.any(String) } });

  // A refusal from the simulator is a 422; a host the app could not reach or trust would be a 503 instead.
  const refused = await request.post(await connectPath("telegram", "secret"), {
    headers,
    data: { secret: "777000:not-issued" },
  });
  expect(refused.status()).toBe(422);
  expect(await refused.json()).toMatchObject({ error: { details: { reason: "secret_refused" } } });
});

test("the app registers with the Mastodon test instance over https, and a browser reaches that instance's sign-in page", async ({
  request,
}) => {
  const started = await request.post(await connectPath("mastodon", "start"), {
    headers: WEB_CLIENT,
    data: { instance_host: MASTODON_HOST },
  });
  expect(started.status()).toBe(200);
  const { data } = (await started.json()) as { data: { authorize_url: string } };
  expect(new URL(data.authorize_url).origin).toBe(`https://${MASTODON_HOST}`);

  // The simulator sends the browser back to the app's callback with a code. The app is not asked to finish the connection
  // (that would add a channel to the workspace): the app's name is sent to a closed port in this browser alone, so the
  // navigation ends there, after the redirect request has been seen.
  const browser = await chromium.launch({ args: simulatorBrowserArgs(["MAP localhost 127.0.0.1:1"]) });
  try {
    const page = await browser.newPage();
    const callbacks: string[] = [];
    page.on("request", (seen) => {
      if (seen.url().includes("/api/v1/connect/mastodon/callback")) callbacks.push(seen.url());
    });
    await expect(page.goto(data.authorize_url)).rejects.toThrow(/ERR_CONNECTION_REFUSED/);
    expect(callbacks).toHaveLength(1);
    const returned = new URL(callbacks[0] ?? "");
    expect(returned.searchParams.get("code")).toBeTruthy();
    expect(returned.searchParams.get("state")).toBeTruthy();
  } finally {
    await browser.close();
  }
});
