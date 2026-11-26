import { type Context, SpanKind } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace";
import { ConfigError } from "@shoutory/core/config";
import { redactUrl } from "../logging/redact-url.js";
import { collectSecrets, createScrubber, type Scrubber } from "../logging/scrub.js";

const ENDPOINT = "OTEL_EXPORTER_OTLP_ENDPOINT";
const URL_KEYS = ["url.full", "url.path", "http.url", "http.target"];
const PATH_KEYS = ["url.path", "http.target"];
const QUERY_KEY = "url.query";
const QUERY_TEXT_KEYS = ["db.query.text", "db.statement"];
const REDACTED = "[Redacted]";
const UNPARSABLE = "[unparsable]";

export interface Telemetry {
  shutdown(): Promise<void>;
}

function stripUrl(value: string): string {
  const clean = redactUrl(value);
  const query = clean.indexOf("?");
  return query >= 0 ? clean.slice(0, query) : clean;
}

// A request this server makes can carry a secret in its path (a bot token, a webhook id), which no prefix list can
// know, so an outgoing request keeps only scheme, host and port.
function originOnly(span: Span): void {
  for (const key of ["url.full", "http.url"]) {
    const value = span.attributes[key];
    if (typeof value !== "string") continue;
    span.setAttribute(key, URL.canParse(value) ? new URL(value).origin : UNPARSABLE);
  }
  for (const key of [...PATH_KEYS, QUERY_KEY]) {
    if (key in span.attributes) span.setAttribute(key, REDACTED);
  }
}

function stripServerUrl(span: Span): void {
  for (const key of URL_KEYS) {
    const value = span.attributes[key];
    if (typeof value === "string") span.setAttribute(key, stripUrl(value));
  }
  if (QUERY_KEY in span.attributes) span.setAttribute(QUERY_KEY, REDACTED);
}

// PostgreSQL puts the offending row's values in the detail of a constraint or type error: the key, the whole failing
// row, or the rejected input. A value can hold `)` or `"`, so each mask runs greedily to the last closer on its line.
const VALUE_DETAILS = [
  /(Key \([^)]*\)=\().*(\))/g,
  /(Failing row contains \().*(\))/g,
  /(invalid input syntax for type [^:\n]+: ").*(")/g,
];

function maskText(scrub: Scrubber, value: string): string {
  return VALUE_DETAILS.reduce(
    (text, pattern) => text.replace(pattern, `$1${REDACTED}$2`),
    String(scrub(value)),
  );
}

function scrubText(span: Span, scrub: Scrubber): void {
  for (const key of QUERY_TEXT_KEYS) {
    const query = span.attributes[key];
    if (typeof query === "string") span.setAttribute(key, maskText(scrub, query));
  }
  for (const event of span.events) {
    for (const [key, value] of Object.entries(event.attributes ?? {})) {
      if (typeof value === "string" && event.attributes) event.attributes[key] = maskText(scrub, value);
    }
  }
  const { code, message } = span.status;
  if (message !== undefined) span.setStatus({ code, message: maskText(scrub, message) });
}

class UrlStrippingProcessor implements SpanProcessor {
  readonly #next: SpanProcessor;
  readonly #scrub: Scrubber;

  constructor(next: SpanProcessor, secrets: readonly string[]) {
    this.#next = next;
    this.#scrub = createScrubber(secrets);
  }

  onStart(span: Span, context: Context): void {
    this.#next.onStart(span, context);
  }

  onEnding(span: Span): void {
    if (span.kind === SpanKind.CLIENT) originOnly(span);
    else stripServerUrl(span);
    scrubText(span, this.#scrub);
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

export async function createSpanProcessor(
  exporter: SpanExporter,
  secrets: readonly string[],
): Promise<SpanProcessor> {
  const { BatchSpanProcessor } = await import("@opentelemetry/sdk-trace");
  return new UrlStrippingProcessor(new BatchSpanProcessor({ exporter }), secrets);
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
    spanProcessors: [await createSpanProcessor(new OTLPTraceExporter({ url }), collectSecrets(env))],
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
