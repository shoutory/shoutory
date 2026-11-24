import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace";
import { ConfigError } from "@shoutory/core/config";
import { redactUrl } from "../logging/redact-url.js";

const ENDPOINT = "OTEL_EXPORTER_OTLP_ENDPOINT";
const URL_KEYS = ["url.full", "url.path", "http.url", "http.target"];
const QUERY_KEY = "url.query";
const REDACTED = "[Redacted]";

export interface Telemetry {
  shutdown(): Promise<void>;
}

function stripUrl(value: string): string {
  const clean = redactUrl(value);
  const query = clean.indexOf("?");
  return query >= 0 ? clean.slice(0, query) : clean;
}

class UrlStrippingProcessor implements SpanProcessor {
  readonly #next: SpanProcessor;

  constructor(next: SpanProcessor) {
    this.#next = next;
  }

  onStart(span: Span, context: Context): void {
    this.#next.onStart(span, context);
  }

  onEnding(span: Span): void {
    for (const key of URL_KEYS) {
      const value = span.attributes[key];
      if (typeof value === "string") span.setAttribute(key, stripUrl(value));
    }
    if (QUERY_KEY in span.attributes) span.setAttribute(QUERY_KEY, REDACTED);
    this.#next.onEnding?.(span);
  }

  onEnd(span: ReadableSpan): void {
    this.#next.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.#next.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.#next.shutdown();
  }
}

export async function createSpanProcessor(exporter: SpanExporter): Promise<SpanProcessor> {
  const { BatchSpanProcessor } = await import("@opentelemetry/sdk-trace");
  return new UrlStrippingProcessor(new BatchSpanProcessor({ exporter }));
}

export function tracesUrl(endpoint: string): string {
  if (!URL.canParse(endpoint) || !/^https?:$/.test(new URL(endpoint).protocol)) {
    throw new ConfigError(ENDPOINT, `${ENDPOINT} must be an http or https URL`);
  }
  const url = new URL(endpoint);
  url.search = "";
  url.hash = "";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/traces`;
  return url.toString();
}

// Without the endpoint nothing is imported or registered (the SDK would otherwise build OTLP exporters by itself). The
// exporter gets an explicit URL, which beats `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, so only the checked endpoint is used.
export async function startTelemetry(env: NodeJS.ProcessEnv): Promise<Telemetry | undefined> {
  const endpoint = env[ENDPOINT]?.trim();
  if (!endpoint) return undefined;
  const url = tracesUrl(endpoint);
  const [{ NodeSDK }, { OTLPTraceExporter }, http, pg, undici] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/instrumentation-http"),
    import("@opentelemetry/instrumentation-pg"),
    import("@opentelemetry/instrumentation-undici"),
  ]);
  const sdk = new NodeSDK({
    spanProcessors: [await createSpanProcessor(new OTLPTraceExporter({ url }))],
    instrumentations: [
      new http.HttpInstrumentation(),
      new pg.PgInstrumentation(),
      new undici.UndiciInstrumentation(),
    ],
    // Traces only: sdk-node would otherwise default metric and log exporters to OTLP, detect process resources
    // (argv, OS user) and add trace headers to outgoing requests.
    metricReaders: [],
    logRecordProcessors: [],
    autoDetectResources: false,
    textMapPropagator: null,
  });
  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}
