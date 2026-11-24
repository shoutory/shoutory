import { register } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:module", async (original) => ({
  ...(await original<typeof import("node:module")>()),
  register: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the telemetry preload", () => {
  it.each([undefined, "", "   "])(
    "registers no ESM hook and starts nothing when the endpoint is %j",
    async (value) => {
      vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", value);
      const preload = await import("./preload.js");
      expect(preload.telemetry).toBeUndefined();
      expect(register).not.toHaveBeenCalled();
    },
  );

  // An endpoint can carry userinfo or a token: a bad one is kept as the short config error that
  // `main` throws at the start of start-up (reported on stderr, exit code 1), never thrown at import.
  it.each(["http://user:endpoint-canary-0001@", "ftp://user:endpoint-canary-0001@collector.example.test"])(
    "a bad endpoint (%s) is kept as a config error that names the setting and never echoes the value",
    async (endpoint) => {
      vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
      const preload = await import("./preload.js");
      expect(preload.telemetry).toBeUndefined();
      // By name: `resetModules` gives the preload its own copy of the class.
      expect(preload.telemetryFailure?.name).toBe("ConfigError");
      expect(preload.telemetryFailure?.message).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
      expect(String(preload.telemetryFailure?.stack)).not.toContain("endpoint-canary-0001");
    },
  );
});
