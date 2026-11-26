import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, TracerProvider } from "@opentelemetry/sdk-trace";
import { afterEach, describe, expect, it } from "vitest";
import { createSpanProcessor, startTelemetry, tracesUrl } from "./telemetry.js";

afterEach(() => trace.disable());

describe("telemetry is off unless OTEL_EXPORTER_OTLP_ENDPOINT is set", () => {
  it.each([
    ["unset", {}],
    ["empty", { OTEL_EXPORTER_OTLP_ENDPOINT: "" }],
    ["blank", { OTEL_EXPORTER_OTLP_ENDPOINT: "   " }],
  ])("%s: nothing starts and the global tracer provider records nothing", async (_name, env) => {
    expect(await startTelemetry(env)).toBeUndefined();
    expect(trace.getTracer("off-test").startSpan("span").isRecording()).toBe(false);
  });

  it.each(["file:///tmp/collector", "ftp://collector.example.test", "not a url"])(
    "an endpoint that is not http or https (%s) is refused before anything starts",
    async (endpoint) => {
      await expect(startTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint })).rejects.toThrow(
        "OTEL_EXPORTER_OTLP_ENDPOINT",
      );
      expect(trace.getTracer("off-test").startSpan("span").isRecording()).toBe(false);
    },
  );

  it.each([
    ["http://collector.example.test:4318", "http://collector.example.test:4318/v1/traces"],
    ["https://collector.example.test/", "https://collector.example.test/v1/traces"],
    ["https://collector.example.test/otel?x=1#f", "https://collector.example.test/otel/v1/traces"],
  ])("the traces URL for %s is %s", (endpoint, expected) => {
    expect(tracesUrl(endpoint)).toBe(expected);
  });
});

describe("telemetry strips sensitive attributes through the span processor", () => {
  const rows = [
    [
      "url.full query and userinfo",
      "url.full",
      "https://mailer:userinfo-value-0001@example.test/p?token=query-value-0001#frag",
      "/p",
    ],
    ["http.url", "http.url", "http://mailer:userinfo-value-0001@example.test/p?token=query-value-0001", "/p"],
    ["http.target", "http.target", "/p?token=query-value-0001", "/p"],
    ["url.query", "url.query", "token=query-value-0001", "[Redacted]"],
    ["a path token in url.full", "url.full", "https://example.test/token/path-value-0001", "/token/"],
    ["a path token in url.path", "url.path", "/share/path-value-0001", "/share/"],
    ["a path token in http.target", "http.target", "/verify/email/path-value-0001", "/verify/"],
    ["a percent-encoded prefix in url.path", "url.path", "/%73hare/path-value-0001", "/"],
    ["an unparsable url.path", "url.path", "//", "[unparsable]"],
    ["an unparsable http.target", "http.target", "http://", "[unparsable]"],
    ["an unparsable url.full", "url.full", "///", "[unparsable]"],
  ] as const;

  async function exportedAttributes(kind: SpanKind, key: string, value: string) {
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({ spanProcessors: [await createSpanProcessor(exporter, [])] });
    provider
      .getTracer("strip-test")
      .startSpan("span", { kind, attributes: { [key]: value } })
      .end();
    await provider.forceFlush();
    return JSON.stringify(exporter.getFinishedSpans()[0]?.attributes);
  }

  it.each(rows)("%s", async (_title, key, value, kept) => {
    const exported = await exportedAttributes(SpanKind.SERVER, key, value);
    for (const secret of ["query-value-0001", "userinfo-value-0001", "path-value-0001", "frag"]) {
      expect(exported).not.toContain(secret);
    }
    expect(exported).toContain(kept);
  });

  it("a client span with a path secret after a credential prefix is stripped", async () => {
    const exported = await exportedAttributes(
      SpanKind.CLIENT,
      "url.full",
      "https://api.example.test/token/path-value-0001/send",
    );
    expect(exported).not.toContain("path-value-0001");
    expect(exported).toContain("api.example.test");
  });
});

describe("an exported client span keeps only scheme, host and port", () => {
  // [what the request was, the url.full that is kept]
  const CLIENT_URLS = [
    [
      "a range path",
      "https://api.range-host.example.test/range/5BAA6",
      "https://api.range-host.example.test",
    ],
    [
      "a bot token path and a query",
      "https://bot-host.example.test/bot123456:path-value-0001/sendMessage?chat=query-value-0001",
      "https://bot-host.example.test",
    ],
    [
      "a webhook path with a port and userinfo",
      "http://mailer:userinfo-value-0001@hooks.example.test:8443/webhooks/id-1/path-value-0001",
      "http://hooks.example.test:8443",
    ],
  ] as const;

  it.each(CLIENT_URLS)("%s", async (_title, url, kept) => {
    const parsed = new URL(url);
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({ spanProcessors: [await createSpanProcessor(exporter, [])] });
    provider
      .getTracer("client-test")
      .startSpan("span", {
        kind: SpanKind.CLIENT,
        attributes: {
          "url.full": url,
          "url.path": parsed.pathname,
          "url.query": parsed.search.slice(1),
          "url.scheme": parsed.protocol.slice(0, -1),
          "server.address": parsed.hostname,
        },
      })
      .end();
    await provider.forceFlush();
    const attributes = exporter.getFinishedSpans()[0]?.attributes ?? {};
    expect(attributes["url.full"]).toBe(kept);
    expect(attributes["server.address"]).toBe(parsed.hostname);
    const exported = JSON.stringify(attributes);
    for (const secret of [
      "query-value-0001",
      "userinfo-value-0001",
      "path-value-0001",
      "sendMessage",
      "5BAA6",
    ]) {
      expect(exported).not.toContain(secret);
    }
  });
});

describe("span text is scrubbed before export", () => {
  const CANARY = "canary-span-secret-0001";
  const KEY_VALUE = "person-key-value-0001@example.test";
  const DUPLICATE = `duplicate key value violates unique constraint "users_email_key": Key (email)=(${KEY_VALUE}) already exists.`;

  it("an exception event, a status message and `db.query.text` with a registered canary and a key value are exported masked", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({ spanProcessors: [await createSpanProcessor(exporter, [CANARY])] });
    const span = provider.getTracer("scrub-test").startSpan("query", {
      kind: SpanKind.CLIENT,
      attributes: { "db.query.text": `SELECT * FROM users WHERE token = '${CANARY}'` },
    });
    span.recordException(new Error(`${DUPLICATE} ${CANARY}`));
    span.setStatus({ code: SpanStatusCode.ERROR, message: `${DUPLICATE} ${CANARY}` });
    span.end();
    await provider.forceFlush();
    const [finished] = exporter.getFinishedSpans();
    const exported = JSON.stringify({
      attributes: finished?.attributes,
      events: finished?.events,
      status: finished?.status,
    });
    expect(exported).not.toContain(CANARY);
    expect(exported).not.toContain(KEY_VALUE);
    expect(finished?.events[0]?.name).toBe("exception");
    expect(finished?.status.code).toBe(SpanStatusCode.ERROR);
    expect(exported).toContain("users_email_key");
  });
});

describe("PostgreSQL detail values are masked whole", () => {
  it.each([
    [
      "a key value holding a closing parenthesis",
      "Key (email)=(canary-key-0001) b) already exists.",
      "canary-key-0001",
    ],
    ["a failing row", "Failing row contains (1, canary-row-0001, 2026-01-01).", "canary-row-0001"],
    [
      "an invalid input value",
      'invalid input syntax for type uuid: "canary-input-0001"',
      "canary-input-0001",
    ],
  ])("%s is absent from the exported exception event and status message", async (_title, detail, canary) => {
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({ spanProcessors: [await createSpanProcessor(exporter, [])] });
    const span = provider.getTracer("detail-test").startSpan("query", { kind: SpanKind.CLIENT });
    span.recordException(new Error(detail));
    span.setStatus({ code: SpanStatusCode.ERROR, message: detail });
    span.end();
    await provider.forceFlush();
    const [finished] = exporter.getFinishedSpans();
    const exported = JSON.stringify({ events: finished?.events, status: finished?.status });
    expect(exported).not.toContain(canary);
    expect(exported).not.toContain("b)");
  });

  it.each(["db.query.text", "db.statement"])("`%s` is scrubbed", async (key) => {
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({
      spanProcessors: [await createSpanProcessor(exporter, ["canary-stmt-0001"])],
    });
    const span = provider.getTracer("detail-test").startSpan("query", {
      kind: SpanKind.CLIENT,
      attributes: { [key]: "SELECT 1 WHERE token = 'canary-stmt-0001'" },
    });
    span.end();
    await provider.forceFlush();
    expect(JSON.stringify(exporter.getFinishedSpans()[0]?.attributes)).not.toContain("canary-stmt-0001");
  });
});
