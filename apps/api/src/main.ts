import { realpathSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { assertUtc, type Config, databaseUrlOf, parseEnv } from "@shoutory/core/config";
import { assertKeyIdsLoaded } from "@shoutory/core/keys";
import type { StorageDriver } from "@shoutory/core/storage";
import { createAppPool, createAuthDb } from "@shoutory/db/pool";
import { assertMigrationsApplied, sealedKeyIds } from "@shoutory/db/startup";
import { builtInManifests, createBuiltInAdapters } from "@shoutory/provider-registry";
import { closeEgress, type EgressRequest, egressFetch } from "@shoutory/provider-sdk/egress";
import { fetchOf } from "@shoutory/provider-sdk/egress/fetch-adapter";
import {
  createOperatorPolicy,
  type OperatorPolicy,
  requestPolicyOf,
} from "@shoutory/provider-sdk/egress/policy";
import { egressResolveTxt } from "@shoutory/provider-sdk/egress/txt";
import type { Manifest } from "@shoutory/provider-sdk/manifest";
import { createRegistry } from "@shoutory/provider-sdk/registry";
import { createApp } from "./app.js";
import { createAuth } from "./auth/auth.js";
import { RANGE_HOST } from "./auth/hibp.js";
import type { HealthProvider } from "./channels/health.js";
import { type CliIo, run } from "./cli/main.js";
import { refuseEgress } from "./jobs/ledger/held.js";
import { checkFfmpegPath, checkFfprobePath } from "./jobs/media/probe-run.js";
import { createClamdScan } from "./jobs/media/scan.js";
import { sweepScratch } from "./jobs/media/scratch.js";
import { startWorker } from "./jobs/worker.js";
import { createLogger, type Logger } from "./logging/logger.js";
import { collectSecrets, createScrubber } from "./logging/scrub.js";
import { closeServer, closeTogether, drain, firstOnly } from "./shutdown.js";
import { createStorageDriver } from "./storage/driver.js";
import {
  createS3Multipart,
  createS3Presigner,
  type S3Multipart,
  type S3Presigner,
} from "./storage/s3-driver.js";
import { telemetry, telemetryFailure } from "./telemetry/preload.js";

export interface RunningServer {
  readonly port: number;
  close(): Promise<void>;
}
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

// One policy per process, so every caller shares the same connection pools and one call closes them.
const operators = new WeakMap<Config, OperatorPolicy>();

function operatorOf(config: Config): OperatorPolicy {
  let operator = operators.get(config);
  if (operator === undefined) {
    operator = createOperatorPolicy({ allowCidrs: config.egressAllowCidrs });
    operators.set(config, operator);
  }
  return operator;
}

function boundEgress(config: Config) {
  const operator = operatorOf(config);
  const request = { kind: "provider", egressHosts: [RANGE_HOST] } as const;
  return (req: EgressRequest) => egressFetch(req, { request, operator });
}

function importFetch(config: Config) {
  const operator = operatorOf(config);
  const request = { kind: "user_url" } as const;
  return (req: EgressRequest) => egressFetch(req, { request, operator });
}

function providerFetch(config: Config) {
  const operator = operatorOf(config);
  return (manifest: Manifest, instanceHost?: string): typeof fetch => {
    const request = requestPolicyOf(manifest, instanceHost);
    if (request === undefined) return refuseEgress();
    // The worker bounds each call by its own deadline; this is the longest the transport may take for one.
    const timeoutMs = (manifest.uploadTimeoutSeconds ?? manifest.callTimeoutSeconds) * 1000;
    return fetchOf((req) => egressFetch(req, { request, operator }), { timeoutMs });
  };
}

function providerTxt(config: Config) {
  const operator = operatorOf(config);
  return (name: string) => egressResolveTxt(name, operator);
}

function builtInProviders(): Record<string, HealthProvider> {
  const adapters = createBuiltInAdapters();
  return Object.fromEntries(
    createRegistry(builtInManifests).manifests.map((manifest) => {
      const adapter = adapters[manifest.id];
      if (!adapter) throw new Error(`no adapter is built in for provider "${manifest.id}"`);
      return [manifest.id, { manifest, adapter }];
    }),
  );
}

function appSettingsOf(config: Config) {
  return {
    webRoot: config.webRoot,
    mail: { from: config.mailFrom, dkimSelector: config.mailDkimSelector },
    releaseChannel: config.releaseChannel,
    mediaWorkspaceMaxBytes: config.mediaWorkspaceMaxBytes,
    scratchDir: config.scratchDir,
    channels: {
      providers: builtInProviders(),
      fetch: refuseEgress(),
      fetchFor: providerFetch(config),
      resolveTxt: providerTxt(config),
      pepper: config.hmacPepper,
    },
  };
}

function storageOptions(storage: Config["storage"]): {
  storage: StorageDriver;
  presigner?: S3Presigner;
  multipart?: S3Multipart;
} {
  const driver = createStorageDriver(storage);
  if (storage.driver !== "s3") return { storage: driver };
  const multipart = createS3Multipart(storage);
  const close = () => {
    driver.close?.();
    multipart.close();
  };
  return { storage: { ...driver, close }, presigner: createS3Presigner(storage), multipart };
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
    const stores = { ...storageOptions(config.storage), mediaImportFetch: importFetch(config) };
    opened = stores.storage;
    // The profile picture is decoded in this process, so its scratch folder is swept here as the worker sweeps its own.
    await sweepScratch(config.scratchDir);
    const app = createApp({
      publicOrigin,
      trustedProxies: config.trustedProxies,
      pool,
      keys: config.keys,
      logger,
      auth,
      ...stores,
      ...appSettingsOf(config),
    });
    const server = await listen(app.fetch, config.port, config.host);
    logger.info({ port: server.port, role: config.role }, "listening");
    const close = async (): Promise<void> => {
      await server.close();
      stores.storage.close?.();
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

async function checkVideoTools(config: Config, logger: Logger): Promise<void> {
  if (config.videoTools === undefined) {
    const variables = ["SHOUTORY_FFPROBE_PATH", "SHOUTORY_FFMPEG_PATH"];
    return logger.info({ variables }, "video is off: the variables are not set");
  }
  await checkFfprobePath(config.videoTools.ffprobe);
  await checkFfmpegPath(config.videoTools.ffmpeg);
}

async function startWorkerRole(
  config: Config,
  logger: Logger,
  role: "worker" | "all",
): Promise<{ close(): Promise<void> }> {
  const url = databaseUrlOf(config, "worker").expose();
  const pool = createAppPool(url, (error) => logger.error({ err: error }, "worker database pool error"));
  // The same storage as the api reads: the image pipeline runs here, and a driver that cannot open stops the start.
  let storage: StorageDriver | undefined;
  try {
    storage = createStorageDriver(config.storage);
    await assertMigrationsApplied(pool);
    await checkVideoTools(config, logger);
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
      media: {
        storage,
        scratchDir: config.scratchDir,
        ...(config.storage.driver === "fs" ? { partsRoot: config.storage.dataDir } : {}),
        ...(config.mediaScan.mode === "warn" ? { scan: createClamdScan(config.mediaScan) } : {}),
        ...(config.videoTools === undefined ? {} : { video: config.videoTools }),
      },
      adapters: createBuiltInAdapters(),
      fetchFor: providerFetch(config),
      resolveTxt: providerTxt(config),
    });
    logger.info({ role }, "worker started");
    return {
      close: async () => {
        await worker.close();
        storage?.close?.();
        await pool.end();
      },
    };
  } catch (error) {
    storage?.close?.();
    await pool
      .end()
      .catch((endError: unknown) => logger.error({ err: endError }, "worker database pool did not close"));
    throw error;
  }
}

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
      try {
        await closeEgress(operatorOf(config));
      } finally {
        await telemetry?.shutdown();
      }
    }
  };
  return "server" in started ? { server: { port: started.server.port, close } } : { worker: { close } };
}

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
