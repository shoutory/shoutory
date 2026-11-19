import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { assertUtc, type Config, parseEnv } from "@shoutory/core/config";
import { assertKeyIdsLoaded } from "@shoutory/core/keys";
import { createAppPool, createAuthDb } from "@shoutory/db/pool";
import { assertMigrationsApplied, sealedKeyIds } from "@shoutory/db/startup";
import { createApp } from "./app.js";
import { createAuth } from "./auth/auth.js";
import { type CliIo, collectSecrets, run } from "./cli/main.js";
import { startWorker } from "./jobs/worker.js";
import { createLogger, type Logger } from "./logging/logger.js";
import { createScrubber } from "./logging/scrub.js";
import { startTelemetry } from "./telemetry/telemetry.js";

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
  fetch: (request: Request, env: unknown) => Response | Promise<Response>,
  port: number,
  host: string | undefined,
) {
  return new Promise<RunningServer>((done, fail) => {
    // No host means the Node default (all interfaces).
    const server = serve({ fetch, port, ...(host ? { hostname: host } : {}) }, (info) => {
      server.off("error", fail);
      done({
        port: info.port,
        close: () => new Promise<void>((ok, bad) => server.close((error) => (error ? bad(error) : ok()))),
      });
    });
    server.once("error", fail);
  });
}

async function startServer(config: Config, logger: Logger): Promise<RunningServer> {
  const pool = createAppPool(config.databaseUrls.app.expose(), (error) =>
    logger.error({ err: error }, "database pool error"),
  );
  const authPool = createAppPool(config.databaseUrls.auth.expose(), (error) =>
    logger.error({ err: error }, "auth database pool error"),
  );
  try {
    await assertMigrationsApplied(pool);
    assertKeyIdsLoaded(await sealedKeyIds(pool), config.keys);
    const publicOrigin = config.publicOrigin;
    if (publicOrigin === undefined) throw new Error("SHOUTORY_PUBLIC_ORIGIN is required");
    // The SPA static route is registered here, after every other route, once its folder is configured.
    const auth = createAuth({
      publicOrigin,
      secret: config.sessionSecret.expose(),
      pepper: config.hmacPepper,
      keys: config.keys,
      db: createAuthDb(authPool),
      pool: authPool,
      appPool: pool,
      fetch,
      logger,
    });
    // The library starts asynchronously; a bad configuration refuses the start here, not on the first request.
    await auth.library.$context;
    const app = createApp({
      publicOrigin,
      trustedProxies: config.trustedProxies,
      pool,
      keys: config.keys,
      logger,
      auth,
    });
    const server = await listen(app.fetch, config.port, config.host);
    logger.info({ port: server.port, role: config.role }, "listening");
    const close = async (): Promise<void> => {
      await server.close();
      await Promise.all([pool.end(), authPool.end()]);
    };
    return { port: server.port, close };
  } catch (error) {
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
  const url = config.databaseUrls.worker.expose();
  const pool = createAppPool(url, (error) => logger.error({ err: error }, "worker database pool error"));
  try {
    await assertMigrationsApplied(pool);
    const worker = await startWorker({ connectionString: url, pool, logger, role });
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
        // The server closes even when the worker's close throws.
        close: async () => {
          try {
            await worker.close();
          } finally {
            await server.close();
          }
        },
      },
    };
  } catch (error) {
    await server
      .close()
      .catch((closeError: unknown) => logger.error({ err: closeError }, "server did not close"));
    throw error;
  }
}

/** Start order: UTC, configuration, telemetry, logger, migration check, listen. Any refusal happens before listen. */
async function start(env: NodeJS.ProcessEnv, io: CliIo): Promise<Started> {
  assertUtc(env);
  const config = parseEnv(env);
  const telemetry = await startTelemetry(env);
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
  const close = async (): Promise<void> => {
    await running?.close();
    await telemetry?.shutdown();
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
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      running.close().catch((error: unknown) => {
        io.stderr(error instanceof Error ? error.message : "shutdown failed");
        process.exitCode = EXIT_FAILED;
      });
    });
  }
}

/** True when this file is the one node was started on; real paths, so a symlinked start still matches. */
function isEntry(): boolean {
  const started = process.argv[1];
  return started !== undefined && realpathSync(started) === realpathSync(fileURLToPath(import.meta.url));
}

if (isEntry()) {
  void runProcess();
}
