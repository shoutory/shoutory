// Runs inside the simulators container, bundled by the fixture: the four provider simulators on loopback ports behind
// one https server on 443 that picks the simulator by the Host header. It reads the certificate and key from /sim and
// writes /sim/ready.json once it listens.
import { readFileSync, writeFileSync } from "node:fs";
import { request as forward } from "node:http";
import { createServer } from "node:https";
import { startBlueskySimulator } from "../../packages/providers/bluesky/src/simulator";
import { startDiscordSimulator } from "../../packages/providers/discord/src/simulator";
import { startMastodonSimulator } from "../../packages/providers/mastodon/src/simulator";
import { startTelegramSimulator } from "../../packages/providers/telegram/src/simulator";
import { SIMULATOR_HOSTS } from "./simulators-plan";

const now = () => new Date();

async function main(): Promise<void> {
  const telegram = await startTelegramSimulator();
  const discord = await startDiscordSimulator();
  const mastodon = await startMastodonSimulator({ now });
  const bluesky = await startBlueskySimulator({ now });
  const targets = new Map<string, URL>();
  const behind = { telegram, discord, mastodon, bluesky };
  for (const [name, hosts] of Object.entries(SIMULATOR_HOSTS)) {
    for (const host of hosts) targets.set(host, new URL(behind[name as keyof typeof behind].url));
  }

  const server = createServer(
    { key: readFileSync("/sim/server.key"), cert: readFileSync("/sim/server.pem") },
    (incoming, outgoing) => {
      const target = targets.get((incoming.headers.host ?? "").replace(/:\d+$/, ""));
      if (!target) {
        outgoing.writeHead(421).end();
        return;
      }
      // The Host header goes on unchanged: the Mastodon simulator names itself from it.
      const onward = forward(
        {
          host: target.hostname,
          port: target.port,
          method: incoming.method,
          path: incoming.url,
          headers: incoming.headers,
        },
        (answer) => {
          outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(outgoing);
        },
      );
      onward.on("error", () => outgoing.writeHead(502).end());
      incoming.pipe(onward);
    },
  );
  await new Promise<void>((resolve) => server.listen(443, "0.0.0.0", resolve));
  writeFileSync(
    "/sim/ready.json",
    JSON.stringify({ telegramToken: telegram.issueToken(), discordWebhook: discord.urlFor() }),
  );
}

await main();
