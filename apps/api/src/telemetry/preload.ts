import { register } from "node:module";
import { ConfigError } from "@shoutory/core/config";
import { startTelemetry, type Telemetry } from "./telemetry.js";

// The image starts node with `--import` of this file, so the ESM hook is registered and the SDK has patched `node:http`
// before the server module loads it; started later, the incoming-request span of an ESM build would be missing.
// `main.ts` imports `telemetry` from here: the module runs once, preloaded or not, and main takes the shutdown handle.
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) {
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
}

async function start(): Promise<{ telemetry?: Telemetry; failure?: Error }> {
  try {
    const telemetry = await startTelemetry(process.env);
    return telemetry ? { telemetry } : {};
  } catch (error) {
    // A throw here would be an uncaught error at import. Only a refused setting is kept, for `main` to report as the
    // short config error every other setting gets; anything else is not echoed (an endpoint can carry a token).
    const name = error instanceof Error ? error.name : "unknown";
    return {
      failure: error instanceof ConfigError ? error : new Error(`telemetry could not start (${name})`),
    };
  }
}

const started = await start();
export const telemetry = started.telemetry;
/** Why telemetry did not start, when it was asked to; `main` ends start-up with it. */
export const telemetryFailure = started.failure;
