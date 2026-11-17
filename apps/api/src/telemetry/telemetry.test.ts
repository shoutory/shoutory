import { SpanKind, trace } from "@opentelemetry/api";
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
    const provider = new TracerProvider({ spanProcessors: [await createSpanProcessor(exporter)] });
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
