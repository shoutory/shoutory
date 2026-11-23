import { realpathSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { assertUtc, type Config, databaseUrlOf, parseEnv } from "@shoutory/core/config";
import { assertKeyIdsLoaded } from "@shoutory/core/keys";
import type { StorageDriver } from "@shoutory/core/storage";
import { createAppPool, createAuthDb } from "@shoutory/db/pool";
import { assertMigrationsApplied, sealedKeyIds } from "@shoutory/db/startup";
import { type EgressRequest, egressFetch } from "@shoutory/provider-sdk/egress";
import { fetchOf } from "@shoutory/provider-sdk/egress/fetch-adapter";
import { createOperatorPolicy } from "@shoutory/provider-sdk/egress/policy";
import type { Manifest } from "@shoutory/provider-sdk/manifest";
import { createApp } from "./app.js";
import { createAuth } from "./auth/auth.js";
import { RANGE_HOST } from "./auth/hibp.js";
import { type CliIo, collectSecrets, run } from "./cli/main.js";
import { startWorker } from "./jobs/worker.js";
import { createLogger, type Logger } from "./logging/logger.js";
import { createScrubber } from "./logging/scrub.js";
import { closeServer, closeTogether, drain, firstOnly } from "./shutdown.js";
import { createStorageDriver } from "./storage/driver.js";
import { telemetry, telemetryFailure } from "./telemetry/preload.js";

export interface RunningServer {
  readonly port: number;
  close(): Promise<void>;
}
/** A process that refused to start (or ran a command) has an exit code and listens on nothing; a worker has no port. */
export type Started =
  | { readonly exitCode: number }
  | { readonly server: RunningServer }
  | { readonly worker: { close(): Promise<void> } };

const EXIT_FAILED = 1;

function listen(
  handler: (request: Request, env: unknown) => Response | Promise<Response>,
  port: number,
  host: string | undefined,
) {
  return new Promise<RunningServer>((done, fail) => {
    // No host means the Node default (all interfaces).
    const server = serve({ fetch: handler, port, ...(host ? { hostname: host } : {}) }, (info) => {
      server.off("error", fail);
      done({
        port: info.port,
        close: () => closeServer(server as Server),
      });
    });
    server.once("error", fail);
  });
}

/** The one operator network policy, built from instance configuration, bound to the breach-check host. */
function boundEgress(config: Config) {
  const operator = createOperatorPolicy({ allowCidrs: config.egressAllowCidrs });
  const request = { kind: "provider", egressHosts: [RANGE_HOST] } as const;
  return (req: EgressRequest) => egressFetch(req, { request, operator });
}

/** The `fetch` of a provider adapter: the same operator policy, narrowed to the hosts its manifest names. */
function providerFetch(config: Config) {
  const operator = createOperatorPolicy({ allowCidrs: config.egressAllowCidrs });
  return (manifest: Manifest) =>
    fetchOf((req) =>
      egressFetch(req, { request: { kind: "provider", egressHosts: manifest.egressHosts }, operator }),
    );
}

async function startServer(config: Config, logger: Logger): Promise<RunningServer> {
  const pool = createAppPool(databaseUrlOf(config, "app").expose(), (error) =>
    logger.error({ err: error }, "database pool error"),
  );
  const authPool = createAppPool(databaseUrlOf(config, "auth").expose(), (error) =>
    logger.error({ err: error }, "auth database pool error"),
  );
  let opened: StorageDriver | undefined;
  try {
    await assertMigrationsApplied(pool);
    assertKeyIdsLoaded(await sealedKeyIds(pool), config.keys);
    const publicOrigin = config.publicOrigin;
    if (publicOrigin === undefined) throw new Error("SHOUTORY_PUBLIC_ORIGIN is required");
    const auth = createAuth({
      publicOrigin,
      secret: config.sessionSecret.expose(),
      pepper: config.hmacPepper,
      keys: config.keys,
      db: createAuthDb(authPool),
      pool: authPool,
      appPool: pool,
      fetch: boundEgress(config),
      logger,
    });
    // The library starts asynchronously; a bad configuration refuses the start here, not on the first request.
    await auth.library.$context;
    const storage = createStorageDriver(config.storage);
    opened = storage;
    const app = createApp({
      publicOrigin,
      trustedProxies: config.trustedProxies,
      pool,
      keys: config.keys,
      logger,
      auth,
      storage,
      webRoot: config.webRoot,
      mail: { from: config.mailFrom, dkimSelector: config.mailDkimSelector },
      releaseChannel: config.releaseChannel,
    });
    const server = await listen(app.fetch, config.port, config.host);
    logger.info({ port: server.port, role: config.role }, "listening");
    const close = async (): Promise<void> => {
      await server.close();
      storage.close?.();
      await Promise.all([pool.end(), authPool.end()]);
    };
    return { port: server.port, close };
  } catch (error) {
    opened?.close?.();
    // A failing close must not hide why the start failed.
    await Promise.all([pool.end(), authPool.end()]).catch((endError: unknown) =>
      logger.error({ err: endError }, "database pool did not close"),
    );
    throw error;
  }
}

/** The worker role over its own pool: the queue client, schedules, heartbeat and outbox relay (R316). */
async function startWorkerRole(
  config: Config,
  logger: Logger,
  role: "worker" | "all",
): Promise<{ close(): Promise<void> }> {
  const url = databaseUrlOf(config, "worker").expose();
  const pool = createAppPool(url, (error) => logger.error({ err: error }, "worker database pool error"));
  try {
    await assertMigrationsApplied(pool);
    // The worker and all roles need the sender; the configuration refuses a start without it.
    if (config.mailFrom === undefined) throw new Error("SHOUTORY_MAIL_FROM is required");
    const mail = {
      keys: config.keys,
      pepper: config.hmacPepper,
      smtpUrl: config.smtpUrl,
      from: config.mailFrom,
      marketingFrom: config.mailMarketingFrom,
      publicOrigin: config.publicOrigin,
    };
    const worker = await startWorker({
      connectionString: url,
      pool,
      logger,
      role,
      mail,
      fetchFor: providerFetch(config),
    });
    logger.info({ role }, "worker started");
    return {
      close: async () => {
        await worker.close();
        await pool.end();
      },
    };
  } catch (error) {
    await pool
      .end()
      .catch((endError: unknown) => logger.error({ err: endError }, "worker database pool did not close"));
    throw error;
  }
}

/** HTTP for `api` and `all`, the worker for `worker` and `all`; each part that started is closed if a later one fails. */
async function startRole(config: Config, logger: Logger): Promise<Started> {
  if (config.role === "worker") return { worker: await startWorkerRole(config, logger, "worker") };
  const server = await startServer(config, logger);
  if (config.role === "api") return { server };
  try {
    const worker = await startWorkerRole(config, logger, "all");
    return {
      server: {
        port: server.port,
        // Both stop at once: the worker stops fetching while the server finishes its requests, and one failing
        // never leaves the other running.
        close: () => closeTogether([() => server.close(), () => worker.close()]),
      },
    };
  } catch (error) {
    await server
      .close()
      .catch((closeError: unknown) => logger.error({ err: closeError }, "server did not close"));
    throw error;
  }
}

/** Start order: telemetry (the preload, before this module), UTC, configuration, logger, migration check, listen. */
async function start(env: NodeJS.ProcessEnv, io: CliIo): Promise<Started> {
  if (telemetryFailure) throw telemetryFailure;
  assertUtc(env);
  const config = parseEnv(env);
  const logger = createLogger({
    secrets: collectSecrets(env),
    stream: { write: (line) => io.stdout(line.trimEnd()) },
  });
  let started: Started;
  try {
    started = await startRole(config, logger);
  } catch (error) {
    await telemetry
      ?.shutdown()
      .catch((stopError: unknown) => logger.error({ err: stopError }, "telemetry did not shut down"));
    throw error;
  }
  const running = "server" in started ? started.server : "worker" in started ? started.worker : undefined;
  // Telemetry stops after the role, inside the same bounded close, and also when the role's close failed.
  const close = async (): Promise<void> => {
    try {
      await running?.close();
    } finally {
      await telemetry?.shutdown();
    }
  };
  return "server" in started ? { server: { port: started.server.port, close } } : { worker: { close } };
}

/**
 * The one process entry. With a command in argv it runs the command and returns its exit code; otherwise it starts
 * the server for the configured role.
 */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<Started> {
  if (argv.length > 0) return { exitCode: await run(argv, env, io) };
  try {
    return await start(env, io);
  } catch (error) {
    const message = error instanceof Error ? error.message : "the process failed to start";
    io.stderr(String(createScrubber(collectSecrets(env))(message)));
    return { exitCode: EXIT_FAILED };
  }
}

async function runProcess(): Promise<void> {
  const io: CliIo = {
    stdout: (line) => void process.stdout.write(`${line}\n`),
    stderr: (line) => void process.stderr.write(`${line}\n`),
  };
  const started = await main(process.argv.slice(2), process.env, io);
  if ("exitCode" in started) {
    process.exitCode = started.exitCode;
    return;
  }
  const running = "server" in started ? started.server : started.worker;
  // One guard for both signals: whichever arrives first drains, later ones are ignored.
  const onSignal = firstOnly(() => {
    void drain(() => running.close()).then((outcome) => {
      if (outcome.code !== 0) io.stderr(`shutdown ended without finishing: ${outcome.reason}`);
      // A request that never ends keeps the event loop alive: the exit is explicit.
      process.exit(outcome.code);
    });
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, onSignal);
}

/** True when this file is the one node was started on; real paths, so a symlinked start still matches. */
function isEntry(): boolean {
  const started = process.argv[1];
  return started !== undefined && realpathSync(started) === realpathSync(fileURLToPath(import.meta.url));
}

if (isEntry()) {
  void runProcess();
}
