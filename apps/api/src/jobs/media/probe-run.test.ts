import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { checkFfmpegPath, checkFfprobePath, parseProbe, runProbe, runRemux } from "./probe-run.js";

// `spawn` is replaced by a fake child (a real one cannot be killed by a signal on every host); what ffprobe prints is
// recorded from the shipped binary, and the binary itself is proved in the image smoke test.
vi.mock("node:child_process", async (importOriginal) => ({ ...(await importOriginal()), spawn: vi.fn() }));

const FIXTURES = new URL("../../../test/fixtures/ffprobe/", import.meta.url);
const recorded = (name: string): unknown => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
type Json = { streams: Record<string, unknown>[]; format: Record<string, unknown> };
const h264 = recorded("h264.mp4.json") as Json;
const stream = (change: Record<string, unknown>): Json => ({
  ...h264,
  streams: [{ ...h264.streams[0], ...change }],
});
const format = (change: Record<string, unknown>): Json => ({
  ...h264,
  format: { ...h264.format, ...change },
});

describe("parseProbe on what the shipped ffprobe printed", () => {
  it.each([
    ["h264.mp4", { codec: "h264", family: "mov" }],
    ["hevc.mov", { codec: "hevc", family: "mov" }],
    ["vp9.webm", { codec: "vp9", family: "matroska" }],
  ])("%s gives codec, size, length in ms and the container family", (name, expected) => {
    expect(parseProbe(recorded(`${name}.json`))).toEqual({
      ok: true,
      width: 320,
      height: 240,
      durationMs: 2000,
      ...expected,
    });
  });

  const cover = {
    index: 0,
    codec_name: "mjpeg",
    codec_type: "video",
    width: 9,
    height: 9,
    disposition: { attached_pic: 1 },
  };
  it.each([
    [
      "the length of the stream when the container gives none",
      format({ duration: undefined }),
      { durationMs: 2000 },
    ],
    [
      "the first video stream that is not a cover picture",
      { ...h264, streams: [cover, h264.streams[0]] },
      {},
    ],
    ["a length rounded to the nearest millisecond", format({ duration: "2.0006" }), { durationMs: 2001 }],
    [
      "the longest length the column holds",
      format({ duration: "2147483.647" }),
      { durationMs: 2_147_483_647 },
    ],
  ])("takes %s", (_name, json, expected) => {
    expect(parseProbe(json)).toMatchObject({ ok: true, codec: "h264", width: 320, ...expected });
  });
});

describe("parseProbe stores the size a viewer sees", () => {
  // Recorded from the image's own binaries: `ffmpeg -display_rotation 90 -i h264.mp4 -c copy`, then the probe argv.
  it("swaps the size of the recorded quarter-turned video", () => {
    expect(parseProbe(recorded("h264-rotated.mp4.json"))).toMatchObject({
      ok: true,
      width: 240,
      height: 320,
    });
  });

  const matrix = { side_data_type: "Display Matrix", displaymatrix: "\n" };
  const turned = (entry: Record<string, unknown>) => stream({ side_data_list: [entry] });
  it.each([
    ["a quarter turn one way", turned({ ...matrix, rotation: 90 }), 240, 320],
    ["a quarter turn the other way", turned({ ...matrix, rotation: -90 }), 240, 320],
    ["no turn", turned({ ...matrix, rotation: 0 }), 320, 240],
    ["a half turn", turned({ ...matrix, rotation: 180 }), 320, 240],
    ["a half turn the other way", turned({ ...matrix, rotation: -180 }), 320, 240],
    ["a turn that is no quarter", turned({ ...matrix, rotation: 45 }), 320, 240],
    ["a turn just short of a quarter", turned({ ...matrix, rotation: 89 }), 320, 240],
    ["a turn that is no number", turned({ ...matrix, rotation: "90" }), 320, 240],
    ["a matrix with no turn printed", turned(matrix), 320, 240],
    ["other side data", turned({ side_data_type: "Stereo 3D", rotation: 90 }), 320, 240],
  ])("stores the shown size for %s", (_name, json, width, height) => {
    expect(parseProbe(json)).toMatchObject({ ok: true, width, height });
  });
});

describe("parseProbe refuses what is no usable video", () => {
  const noLength = {
    ...format({ duration: undefined }),
    streams: [{ ...h264.streams[0], duration: undefined }],
  };
  it.each([
    ["the answer for a truncated file", recorded("truncated.mp4.json"), "corrupt"],
    ["an answer that is no object", null, "corrupt"],
    ["no width", stream({ width: undefined }), "corrupt"],
    ["a zero width", stream({ width: 0 }), "corrupt"],
    ["a zero height", stream({ height: 0 }), "corrupt"],
    ["no codec name", stream({ codec_name: undefined }), "corrupt"],
    ["no length at all", noLength, "corrupt"],
    ["a zero length", format({ duration: "0.000000" }), "corrupt"],
    ["a length that rounds to no millisecond", format({ duration: "0.0004" }), "corrupt"],
    ["a length that is not a number", format({ duration: "N/A" }), "corrupt"],
    ["a length one millisecond past the column", format({ duration: "2147483.648" }), "too_long"],
    ["no stream", { ...h264, streams: [] }, "unsupported_type"],
    [
      "an audio stream only",
      { ...h264, streams: [{ index: 0, codec_name: "aac", codec_type: "audio" }] },
      "unsupported_type",
    ],
    ["a cover picture only", stream({ disposition: { attached_pic: 1 } }), "unsupported_type"],
  ])("refuses %s as %s", (_name, json, reason) => {
    expect(parseProbe(json)).toEqual({ ok: false, reason });
  });
});

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  pid: number | undefined = 4242;
  readonly killed: string[] = [];
  kill = (signal: string) => {
    this.killed.push(signal);
    if (this.killed.length === 1) queueMicrotask(() => this.emit("close", null, signal));
    return true;
  };

  async exit(code: number, output = ""): Promise<void> {
    this.stdout.end(output);
    await once(this.stdout, "end");
    this.emit("close", code, null);
  }
}

let child: FakeChild;
beforeEach(() => {
  child = new FakeChild();
  vi.mocked(spawn).mockReset();
  // A caller's abort signal reaches the child as Node does it: the child is killed.
  vi.mocked(spawn).mockImplementation(((
    _command: string,
    _args: string[],
    options: { signal?: AbortSignal },
  ) => {
    options.signal?.addEventListener("abort", () => child.kill("SIGKILL"));
    return child;
  }) as never);
});
afterEach(() => vi.useRealTimers());

const INPUT = join(tmpdir(), "probe-input");
const BINARY = process.execPath;
const CAP = 256 * 1024;
const run = (extra: object = {}) =>
  runProbe({ ffprobePath: BINARY, inputPath: INPUT, demuxer: "mov", ...extra });
const settle = () => new Promise<void>((done) => setImmediate(done));
const answer = JSON.stringify(h264);
const TIMEOUT = { ok: false, reason: "timeout" };
const CORRUPT = { ok: false, reason: "corrupt" };

describe("ffprobe gets nothing from the server and nothing but one local file", () => {
  it("starts by its absolute path with the fixed argv, an empty environment and no shell", async () => {
    process.env.SHOUTORY_CANARY = "canary-secret-1";
    try {
      const done = expect(run()).resolves.toMatchObject({ ok: true });
      await settle();
      await child.exit(0, answer);
      await done;
      const [command, args, options] = vi.mocked(spawn).mock.calls[0] as unknown as [
        string,
        string[],
        Record<string, unknown>,
      ];
      expect(command).toBe(BINARY);
      expect(args).toEqual([
        "-protocol_whitelist",
        "file",
        "-v",
        "error",
        "-of",
        "json",
        "-show_format",
        "-show_streams",
        "-f",
        "mov",
        INPUT,
      ]);
      expect(options.env).toEqual({});
      expect(options.shell ?? false).toBe(false);
      expect(JSON.stringify(options)).not.toContain("canary-secret-1");
    } finally {
      delete process.env.SHOUTORY_CANARY;
    }
  });

  it.each([
    [
      "an input that starts with a dash, which ffprobe would read as an option",
      { inputPath: "-protocol_whitelist" },
    ],
    ["a program name to be searched on the path", { ffprobePath: "ffprobe" }],
  ])("refuses %s before anything is started", async (_name, extra) => {
    await expect(run(extra)).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("a probe is bounded", () => {
  it("is killed at 15 seconds and the file is rejected as a timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const done = run();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(child.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.killed).toEqual(["SIGKILL"]);
    await expect(done).resolves.toEqual(TIMEOUT);
  });

  // The file crashed ffprobe: a verdict, since a retry would only burn 15 seconds three times.
  it.each(["SIGSEGV", "SIGABRT", "SIGBUS", "SIGFPE", "SIGILL"])(
    "a probe that dies of %s is corrupt",
    async (signal) => {
      const done = expect(run()).resolves.toEqual(CORRUPT);
      await settle();
      child.emit("close", null, signal);
      await done;
    },
  );

  it("keeps the verdict of a probe that exited by itself as its time ran out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    child.kill = (signal: string) => child.killed.push(signal) > 0;
    const done = expect(run()).resolves.toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(15_000);
    child.stdout.end(answer);
    await once(child.stdout, "end");
    child.emit("close", 0, null);
    await done;
  });

  it("a probe that exits non-zero has judged the file corrupt", async () => {
    const done = expect(run()).resolves.toEqual(CORRUPT);
    await settle();
    await child.exit(1);
    await done;
  });
});

describe("a probe that fails on its own, says too much or is given up on", () => {
  // Our own failures are not a verdict on the file: they throw, and the asset stays as it was for a retry.
  it.each([
    ["is killed by a signal that was not ours", async () => void child.emit("close", null, "SIGTERM")],
    [
      "cannot be started",
      async () => {
        child.pid = undefined;
        child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
      },
    ],
    ["exits 0 with output that is not JSON", () => child.exit(0, "not json")],
    // An error with no kill of ours pending (a failed kill, a broken pipe) must still settle the probe.
    ["reports an error while it runs", async () => void child.emit("error", new Error("EPIPE"))],
  ])("a probe that %s is a crash of ours, not a verdict", async (_name, happen) => {
    const done = expect(run()).rejects.toThrow();
    await settle();
    await happen();
    await done;
  });

  it.each([
    ["exactly the cap is read", CAP, false],
    ["one byte over the cap is killed and judged corrupt", CAP + 1, true],
  ])("output of %s", async (_name, size, killed) => {
    const done = expect(run()).resolves.toMatchObject(killed ? CORRUPT : { ok: true });
    await settle();
    child.stdout.write(answer + " ".repeat(size - answer.length));
    if (!killed) await child.exit(0);
    await done;
    expect(child.killed).toEqual(killed ? ["SIGKILL"] : []);
  });

  it("is killed and rejected when its caller gives up", async () => {
    const controller = new AbortController();
    const done = expect(run({ signal: controller.signal })).rejects.toThrow();
    await settle();
    controller.abort();
    await done;
    expect(child.killed).toContain("SIGKILL");
  });
});

describe("the worker start check on SHOUTORY_FFPROBE_PATH", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "shoutory-ffprobe-check-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("takes a file that prints `ffprobe version` for -version and exits 0, run under the probe's bounds", async () => {
    const done = expect(checkFfprobePath(BINARY)).resolves.toBeUndefined();
    await settle();
    await child.exit(0, "ffprobe version 9.0.2 Copyright (c) 2007-2026 the FFmpeg developers\n");
    await done;
    const [command, args, options] = vi.mocked(spawn).mock.calls[0] as unknown as [
      string,
      string[],
      { env: object },
    ];
    expect([command, args, options.env]).toEqual([BINARY, ["-version"], {}]);
  });

  it.each([
    ["a file that is not there", () => join(dir, "missing")],
    ["a folder", () => dir],
  ])("refuses %s and names the variable", async (_name, path) => {
    await expect(checkFfprobePath(path())).rejects.toThrow(/SHOUTORY_FFPROBE_PATH/);
  });

  // A wrong executable at the path would reject every video as corrupt for good, so it stops the start instead.
  it.each([
    ["a file that exits non-zero", 1, "ffprobe version 9.0.2\n"],
    ["a program that is not ffprobe", 0, "Node.js v26.13.0\n"],
    ["a program that prints nothing", 0, ""],
  ])("refuses %s", async (_name, code, output) => {
    const done = expect(checkFfprobePath(BINARY)).rejects.toThrow(/SHOUTORY_FFPROBE_PATH/);
    await settle();
    await child.exit(code, output);
    await done;
  });

  it("refuses a program that never ends, killing it at the probe's limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const done = expect(checkFfprobePath(BINARY)).rejects.toThrow(/SHOUTORY_FFPROBE_PATH/);
    // The file checks come first and take real I/O time; the limit runs from the start of the child.
    while (vi.mocked(spawn).mock.calls.length === 0) await settle();
    await vi.advanceTimersByTimeAsync(15_000);
    await done;
    expect(child.killed).toEqual(["SIGKILL"]);
  });
});

describe("the worker start check on SHOUTORY_FFMPEG_PATH", () => {
  it("takes ffmpeg and refuses an ffprobe there", async () => {
    const taken = expect(checkFfmpegPath(BINARY)).resolves.toBeUndefined();
    await settle();
    await child.exit(0, "ffmpeg version 9.0.2 Copyright (c) 2000-2026 the FFmpeg developers\n");
    await taken;
    child = new FakeChild();
    const refused = expect(checkFfmpegPath(BINARY)).rejects.toThrow(/SHOUTORY_FFMPEG_PATH/);
    await settle();
    await child.exit(0, "ffprobe version 9.0.2\n");
    await refused;
  });
});

const OUTPUT = join(tmpdir(), "remux-output");
const remux = (extra: object = {}) =>
  runRemux({ ffmpegPath: BINARY, inputPath: INPUT, outputPath: OUTPUT, type: "video/quicktime", ...extra });

const COPY_FLAGS =
  "-map 0:V:0 -map 0:a:0? -sn -dn -map_metadata -1 -map_chapters -1 -fflags +bitexact -c copy -f";

describe("the stream copy that strips a video (floor)", () => {
  // The child reads one local file with no metadata copied, cannot overwrite, and gets nothing of ours.
  it.each([
    ["video/mp4", "mov", "mp4"],
    ["video/quicktime", "mov", "mov"],
    ["video/webm", "matroska", "webm"],
  ])(
    "%s is copied from its own demuxer into the same container, with an empty environment",
    async (type, demuxer, muxer) => {
      const done = expect(remux({ type })).resolves.toEqual({ ok: true });
      await settle();
      await child.exit(0);
      await done;
      const [command, args, options] = vi.mocked(spawn).mock.calls[0] as unknown as [
        string,
        string[],
        Record<string, unknown>,
      ];
      expect(command).toBe(BINARY);
      expect(args).toEqual([
        ..."-nostdin -n -protocol_whitelist file -f".split(" "),
        demuxer,
        "-i",
        INPUT,
        ...COPY_FLAGS.split(" "),
        muxer,
        OUTPUT,
      ]);
      expect([options.env, options.shell ?? false]).toEqual([{}, false]);
    },
  );

  it.each([
    ["an output path that is not absolute", { outputPath: "stripped" }],
    ["a relative input", { inputPath: "-i" }],
  ])("refuses %s before anything is started", async (_name, extra) => {
    await expect(remux(extra)).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("the verdict of the stream copy", () => {
  // A file that probed fine but cannot be copied is judged as the probe would; a failure of ours is retried.
  it.each([
    ["exits non-zero", () => child.exit(1), CORRUPT],
    ["dies of SIGSEGV", async () => void child.emit("close", null, "SIGSEGV"), CORRUPT],
    [
      "is killed by a signal that was not ours",
      async () => void child.emit("close", null, "SIGTERM"),
      undefined,
    ],
  ])("a copy that %s", async (_name, happen, verdict) => {
    const done = verdict
      ? expect(remux()).resolves.toEqual(verdict)
      : expect(remux()).rejects.toThrow(/ffmpeg/);
    await settle();
    await happen();
    await done;
  });

  it("is killed at 10 minutes and the video is rejected as a timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const done = remux();
    await vi.advanceTimersByTimeAsync(599_999);
    expect(child.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toEqual(TIMEOUT);
  });
});
