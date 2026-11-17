import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { assertUtc, type Config, parseEnv } from "@shoutory/core/config";
import { createAppPool } from "@shoutory/db/pool";
import { assertMigrationsApplied } from "@shoutory/db/startup";
import { createApp } from "./app.js";
import { type CliIo, collectSecrets, run } from "./cli/main.js";
import { createLogger, type Logger } from "./logging/logger.js";
import { createScrubber } from "./logging/scrub.js";
import { startTelemetry } from "./telemetry/telemetry.js";

export interface RunningServer {
  readonly port: number;
  close(): Promise<void>;
}
/** A process that refused to start (or ran a command) has an exit code and listens on nothing. */
export type Started = { readonly exitCode: number } | { readonly server: RunningServer };

const EXIT_FAILED = 1;
const EXIT_REFUSED = 2;

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
  try {
    await assertMigrationsApplied(pool);
    const publicOrigin = config.publicOrigin;
    if (publicOrigin === undefined) throw new Error("SHOUTORY_PUBLIC_ORIGIN is required");
    // The SPA static route is registered here, after every other route, once its folder is configured.
    const app = createApp({
      publicOrigin,
      trustedProxies: config.trustedProxies,
      pool,
      logger,
    });
    const server = await listen(app.fetch, config.port, config.host);
    logger.info({ port: server.port, role: config.role }, "listening");
    const close = async (): Promise<void> => {
      await server.close();
      await pool.end();
    };
    return { port: server.port, close };
  } catch (error) {
    // A failing close must not hide why the start failed.
    await pool
      .end()
      .catch((endError: unknown) => logger.error({ err: endError }, "database pool did not close"));
    throw error;
  }
}

/** Start order: UTC, configuration, telemetry, logger, migration check, listen. Any refusal happens before listen. */
async function start(env: NodeJS.ProcessEnv, io: CliIo): Promise<Started> {
  assertUtc(env);
  const config = parseEnv(env);
  if (config.role === "worker") {
    io.stderr("the worker role has no work until the job queue exists; start with SHOUTORY_ROLE=api or all");
    return { exitCode: EXIT_REFUSED };
  }
  const telemetry = await startTelemetry(env);
  const logger = createLogger({
    secrets: collectSecrets(env),
    stream: { write: (line) => io.stdout(line.trimEnd()) },
  });
  let server: RunningServer;
  try {
    server = await startServer(config, logger);
  } catch (error) {
    await telemetry
      ?.shutdown()
      .catch((stopError: unknown) => logger.error({ err: stopError }, "telemetry did not shut down"));
    throw error;
  }
  const close = async (): Promise<void> => {
    await server.close();
    await telemetry?.shutdown();
  };
  return { server: { port: server.port, close } };
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
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      started.server.close().catch((error: unknown) => {
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
