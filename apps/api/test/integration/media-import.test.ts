import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EgressRequest, egressFetch } from "@shoutory/provider-sdk/egress";
import { createOperatorPolicy, type OperatorPolicy } from "@shoutory/provider-sdk/egress/policy";
import { listenLoopback } from "@shoutory/provider-sdk/loopback";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { processAsset } from "../../src/jobs/media/pipeline.js";
import { createFsDriver } from "../../src/storage/fs-driver.js";
import { leaks } from "../support/canary.js";
import { png } from "../support/images.js";
import {
  addWorkspaceMember,
  seedFilledWorkspace,
  seedOrganization,
  seedWorkspace,
  signedUser,
} from "../support/tenancy.js";
import { type Fixture, startFixture } from "./auth/harness.js";

type User = { id: string; cookie: string };
const MIB = 1024 * 1024;
const CAP = 1024 * MIB;
const CANARY = "import-canary-token-1";
const SEATS = ["owner", "admin", "editor", "approver", "viewer"] as const;
let fx: Fixture;
let dir: string;
let storage: ReturnType<typeof createFsDriver>;
let ws: string;
let other: string;
let server: Server;
let port = 0;
const users: Record<string, User> = {};
const user = (name: string): User => users[name] as User;

// What the simulator answers, by path, and what it was asked: a refused request must leave `asked` as it was.
type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const routes = new Map<string, Handler>();
const asked: { path: string; headers: IncomingMessage["headers"] }[] = [];

// The operator policy the injected fetch uses; each row sets it, and an unset total time is the route's own.
let operator: OperatorPolicy;
let timeoutMs: number | undefined;
// What the route asked for, recorded before a row's own override of the time limit.
let requested: EgressRequest | undefined;
const fetchOf = (request: EgressRequest) => {
  requested = request;
  return egressFetch(timeoutMs === undefined ? request : { ...request, timeoutMs }, {
    request: { kind: "user_url" },
    operator,
  });
};
const policy = (options: { allow?: string[]; schemes?: string[]; ports?: number[]; address?: string } = {}) =>
  createOperatorPolicy({
    allowCidrs: options.allow ?? ["127.0.0.0/8"],
    schemes: options.schemes ?? ["http:"],
    ports: options.ports ?? [port],
    lookup: async () => [{ address: options.address ?? "127.0.0.1", family: 4 }],
  });

beforeAll(async () => {
  server = createServer((req, res) => {
    asked.push({ path: req.url ?? "", headers: req.headers });
    const handler = routes.get((req.url ?? "").split("?")[0] ?? "");
    if (handler) handler(req, res);
    else {
      res.writeHead(404);
      res.end("not here");
    }
  });
  port = await listenLoopback(server);
  operator = policy();
  dir = await mkdtemp(join(tmpdir(), "shoutory-import-"));
  storage = createFsDriver(dir);
  fx = await startFixture({ storage, mediaImportFetch: fetchOf, mediaWorkspaceMaxBytes: CAP });
  const founder = await signedUser(fx, "import-org");
  ws = await seedWorkspace(fx, await seedOrganization(fx, founder.id));
  for (const name of [...SEATS, "outsider", "foreign"]) users[name] = await signedUser(fx, `import-${name}`);
  for (const seat of SEATS) await addWorkspaceMember(fx, ws, user(seat).id, seat);
  other = await seedWorkspace(fx, await seedOrganization(fx, user("foreign").id));
  await addWorkspaceMember(fx, other, user("foreign").id, "owner");
});
afterAll(async () => {
  await fx.close();
  await new Promise<void>((done) => server.close(() => done()));
  await rm(dir, { recursive: true, force: true });
});
afterEach(() => {
  routes.clear();
  asked.length = 0;
  timeoutMs = undefined;
  operator = policy();
});

const base = (workspace: string) => `/api/v1/workspaces/${workspace}/media`;
const importUrl = (who: User, url: string, workspace = ws, signal?: AbortSignal) =>
  fx.request(`${base(workspace)}/import`, {
    method: "POST",
    headers: { cookie: who.cookie },
    body: { url },
    ...(signal === undefined ? {} : { signal }),
  });
const at = (path: string) => `http://127.0.0.1:${port}${path}`;
const refusal = async (answer: Response) => {
  const { error } = (await answer.json()) as { error: { code: string; details?: { reason?: string } } };
  return [answer.status, error.code, error.details?.reason];
};
const assets = () =>
  fx.admin(
    async (client) =>
      (await client.query("SELECT * FROM app.media_assets WHERE source = 'url_import'")).rows as Record<
        string,
        unknown
      >[],
  );
const stored = async () => (await readdir(dir, { recursive: true })).sort();
const serve = (path: string, body: Buffer | string, headers: Record<string, string> = {}) =>
  routes.set(path, (_req, res) => {
    res.writeHead(200, { "content-type": "image/png", ...headers });
    res.end(body);
  });

async function expectNothing(before: { rows: number; objects: string[] }, requests = 0) {
  expect((await assets()).length).toBe(before.rows);
  expect(await stored()).toEqual(before.objects);
  expect(asked.length).toBe(requests);
}
const snapshot = async () => ({ rows: (await assets()).length, objects: await stored() });
const expectNoSession = () => {
  expect(asked.length).toBeGreaterThan(0);
  for (const { headers } of asked)
    expect(
      Object.keys(headers).filter((name) => /^(cookie|authorization|x-forwarded-.*)$/.test(name)),
    ).toEqual([]);
};

describe("a URL the guard refuses is refused before any request is made (floor)", () => {
  // [row, the policy it leaves open, the URL]: the part of the policy the row is about is the one closed.
  const REFUSED: [string, () => OperatorPolicy, () => string][] = [
    ["a loopback address", () => policy({ allow: [] }), () => at("/a.png")],
    ["a private address", () => policy({ allow: [] }), () => `http://10.0.0.5:${port}/a.png`],
    ["a link-local address", () => policy({ allow: [] }), () => `http://169.254.10.10:${port}/a.png`],
    [
      "the cloud metadata address",
      () => policy({ allow: [] }),
      () => `http://169.254.169.254:${port}/latest/meta-data/`,
    ],
    ["a URL with a user name and password", () => policy(), () => `http://user:pass@127.0.0.1:${port}/a.png`],
    ["a scheme the operator did not allow", () => policy({ schemes: ["https:"] }), () => at("/a.png")],
    ["a port the operator did not allow", () => policy({ ports: [443] }), () => at("/a.png")],
    [
      "a name whose lookup answers a private address",
      () => policy({ allow: [], address: "10.0.0.9" }),
      () => `http://rebind.test:${port}/a.png`,
    ],
  ];
  it.each(REFUSED)("%s answers 422 address_not_allowed and stores nothing", async (_row, policyOf, urlOf) => {
    serve("/a.png", await png());
    operator = policyOf();
    const before = await snapshot();
    expect(await refusal(await importUrl(user("editor"), urlOf()))).toEqual([
      422,
      "unprocessable_content",
      "address_not_allowed",
    ]);
    await expectNothing(before);
  });
});

describe("an import into a workspace at its byte cap (floor)", () => {
  it("answers 422 storage_full and stores nothing", async () => {
    const full = await seedFilledWorkspace(fx, user("editor").id, CAP);
    serve("/a.png", await png());
    const before = await snapshot();
    expect(await refusal(await importUrl(user("editor"), at("/a.png"), full))).toEqual([
      422,
      "unprocessable_content",
      "storage_full",
    ]);
    await expectNothing(before, 1);
  });
});

describe("a redirect is checked like the URL (floor)", () => {
  it("a redirect to the metadata address is refused and nothing is stored", async () => {
    routes.set("/hop", (_req, res) => {
      // On the simulator's port, the one the policy allows: only the address rule can refuse this hop.
      res.writeHead(302, { location: `http://169.254.169.254:${port}/latest/meta-data/` });
      res.end();
    });
    const before = await snapshot();
    expect(await refusal(await importUrl(user("editor"), at("/hop")))).toEqual([
      422,
      "unprocessable_content",
      "address_not_allowed",
    ]);
    await expectNothing(before, 1);
  });

  it("a fourth redirect is refused, so the image behind it is never asked for", async () => {
    for (const n of [1, 2, 3, 4])
      routes.set(`/r${n}`, (_req, res) => {
        res.writeHead(302, { location: n === 4 ? "/img.png" : `/r${n + 1}` });
        res.end();
      });
    serve("/img.png", await png());
    const before = await snapshot();
    expect((await refusal(await importUrl(user("editor"), at("/r1"))))[2]).toBe("address_not_allowed");
    expect(asked.map((row) => row.path)).toEqual(["/r1", "/r2", "/r3", "/r4"]);
    await expectNothing(before, 4);
  });
});

describe("a body over 64 MiB is stopped, never stored (floor)", () => {
  it("is refused by its declared length before a byte is read", async () => {
    routes.set("/big.png", (_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": String(64 * MIB + 1) });
      res.flushHeaders();
      res.on("error", () => undefined);
    });
    const before = await snapshot();
    expect(await refusal(await importUrl(user("editor"), at("/big.png")))).toEqual([
      422,
      "unprocessable_content",
      "too_large",
    ]);
    await expectNothing(before, 1);
  });

  it("is cut when it has no length and runs past the cap", async () => {
    routes.set("/endless.png", (_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.on("error", () => undefined);
      const chunk = Buffer.alloc(MIB, 1);
      let sent = 0;
      const send = () => {
        while (sent <= 64 && !res.destroyed) {
          sent++;
          if (!res.write(chunk)) return void res.once("drain", send);
        }
        res.end();
      };
      send();
    });
    const before = await snapshot();
    expect(await refusal(await importUrl(user("editor"), at("/endless.png")))).toEqual([
      422,
      "unprocessable_content",
      "too_large",
    ]);
    await expectNothing(before, 1);
  }, 60_000);
});

describe("what is not an image or a video is refused, whatever it says it is (floor)", () => {
  it("answers unsupported_type for a page that claims image/png, and stores nothing", async () => {
    serve("/page.png", "<html><body>not an image</body></html>");
    const before = await snapshot();
    expect(await refusal(await importUrl(user("editor"), at("/page.png")))).toEqual([
      422,
      "unprocessable_content",
      "unsupported_type",
    ]);
    await expectNothing(before, 1);
  });

  it("asks for the bytes as they are and refuses an encoded body, however valid the image inside", async () => {
    serve("/packed.png", await png(), { "content-encoding": "gzip" });
    const before = await snapshot();
    expect((await refusal(await importUrl(user("editor"), at("/packed.png"))))[2]).toBe("unsupported_type");
    expect(asked.map((row) => row.headers["accept-encoding"])).toEqual(["identity"]);
    await expectNothing(before, 1);
  });
});

describe("a body that stalls is cut at the time limit (floor)", () => {
  it("answers fetch_failed within the limit for a body that stops part way, and stores nothing", async () => {
    routes.set("/stall.png", (_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": "5000" });
      res.write(Buffer.alloc(100, 1));
      res.on("error", () => undefined);
    });
    timeoutMs = 1_500;
    const before = await snapshot();
    const started = Date.now();
    expect(await refusal(await importUrl(user("editor"), at("/stall.png")))).toEqual([
      422,
      "unprocessable_content",
      "fetch_failed",
    ]);
    expect(Date.now() - started).toBeLessThan(10_000);
    await expectNothing(before, 1);
  }, 30_000);
});

describe("no secret or full URL reaches the log, a row or an answer (floor)", () => {
  const spellings = [CANARY, encodeURIComponent(CANARY)];
  // A canary in the user name, the directory, the file and the query; the file name is the one part the person names.
  const dirty = (path: string) =>
    `${path}/${CANARY}/photo.png?token=${CANARY}&k=${encodeURIComponent(CANARY)}`;
  const everywhere = async (answer: Response, logFrom: number) => {
    const rows = JSON.stringify(await assets());
    const text = [await answer.text(), rows, ...fx.logged.slice(logFrom)].join("\n");
    expect(leaks(text, spellings)).toEqual([]);
    // An import's own log line names what happened, never the host it reached.
    const lines = fx.logged
      .slice(logFrom)
      .filter((line) => /an import was refused|a file was imported/.test(line));
    expect(lines.filter((line) => line.includes("127.0.0.1"))).toEqual([]);
    return rows;
  };

  it.each([
    ["a refused URL", () => `http://${CANARY}:${CANARY}@127.0.0.1:${port}${dirty("")}`, 422],
    ["a fetch that failed", () => at(dirty("/broken")), 422],
  ] as [string, () => string, number][])("%s", async (_row, urlOf, status) => {
    routes.set(`/broken/${CANARY}/photo.png`, (_req, res) => {
      res.writeHead(500);
      res.end(`failed for ${CANARY}`);
    });
    const from = fx.logged.length;
    const answer = await importUrl(user("editor"), urlOf());
    expect(answer.status).toBe(status);
    await everywhere(answer, from);
  });

  it("an import that succeeded keeps only the origin of the URL as its source", async () => {
    serve(`/${CANARY}/photo.png`, await png());
    const from = fx.logged.length;
    const answer = await importUrl(user("editor"), at(dirty("")));
    expect(answer.status).toBe(201);
    expectNoSession();
    const rows = JSON.parse(await everywhere(answer.clone(), from)) as {
      source: string;
      source_ref: string;
    }[];
    expect(rows.map((row) => [row.source, row.source_ref])).toEqual([
      ["url_import", `http://127.0.0.1:${port}`],
    ]);
  });
});

describe("who may import, and into which workspace (floor)", () => {
  it("an Editor can import, a Viewer and an Approver are refused, a stranger and another workspace see 404, and none of them reaches the server", async () => {
    serve("/ok.png", await png());
    expect((await importUrl(user("editor"), at("/ok.png"))).status).toBe(201);
    expectNoSession();
    asked.length = 0;
    const before = await snapshot();
    const refused: [string, Response, number][] = [
      ["a viewer", await importUrl(user("viewer"), at("/ok.png")), 403],
      ["an approver", await importUrl(user("approver"), at("/ok.png")), 403],
      ["a non-member", await importUrl(user("outsider"), at("/ok.png")), 404],
      ["an editor of another workspace", await importUrl(user("foreign"), at("/ok.png")), 404],
      ["an editor through another workspace", await importUrl(user("editor"), at("/ok.png"), other), 404],
    ];
    for (const [who, answer, status] of refused) expect(answer.status, who).toBe(status);
    await expectNothing(before);
  });
});

const dataOf = async (answer: Response) => ((await answer.json()) as { data: { id: string } }).data;
const rowOf = async (id: string) =>
  (await assets()).find((row) => row.id === id) as
    | { state: string; mime: string; file_name: string; source: string }
    | undefined;

describe("an import leaves an ordinary asset", () => {
  it("registers the type of the bytes, not the type the host claimed, and the asset reaches ready", async () => {
    serve("/claimed.bin", await png(12, 12), { "content-type": "application/octet-stream" });
    const answer = await importUrl(user("editor"), at("/claimed.bin"));
    expect(answer.status).toBe(201);
    const { id } = await dataOf(answer);
    expect(await rowOf(id)).toMatchObject({ state: "uploaded", mime: "image/png", source: "url_import" });
    // What the route asks of the fetch: a minute for all of it, the single-upload cap, and the bytes as they are.
    expect(requested).toMatchObject({
      timeoutMs: 60_000,
      maxBytes: 64 * MIB,
      headers: { "accept-encoding": "identity" },
    });
    await processAsset({ pool: fx.db.pool("worker"), storage, scratchDir: tmpdir() }, ws, id);
    expect(await rowOf(id)).toMatchObject({ state: "ready", mime: "image/png" });
  });

  it("answers the first asset when the same bytes are imported again", async () => {
    serve("/twice.png", await png(13, 13));
    const first = await dataOf(await importUrl(user("editor"), at("/twice.png")));
    const second = await dataOf(await importUrl(user("editor"), at("/twice.png")));
    expect(second.id).toBe(first.id);
    expect((await rowOf(first.id))?.state).toBe("uploaded");
  });
});

describe("an import holds its file in memory, so only two run at once (floor)", () => {
  const until = async (done: () => boolean) => {
    for (let tries = 0; tries < 200 && !done(); tries++) await new Promise((r) => setTimeout(r, 25));
    expect(done()).toBe(true);
  };

  it("answers a third import 429 with Retry-After while two are in flight, asks nothing for it, and frees a slot when an import ends, however it ends", async () => {
    const held: ServerResponse[] = [];
    for (const path of ["/held-1.png", "/held-2.png"]) routes.set(path, (_req, res) => void held.push(res));
    serve("/third.png", await png(16, 16));
    const first = importUrl(user("editor"), at("/held-1.png"));
    const second = importUrl(user("editor"), at("/held-2.png"));
    await until(() => held.length === 2);
    // The held answers are always ended, so a failing assertion cannot leave the two slots taken for the rows after it.
    try {
      const third = await importUrl(user("editor"), at("/third.png"));
      expect(third.status).toBe(429);
      expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
      // The two imports run at once and reach the server in either order: what was asked is a set.
      expect(asked.map((row) => row.path).sort()).toEqual(["/held-1.png", "/held-2.png"]);
    } finally {
      for (const [n, res] of held.entries()) {
        const body = await png(17 + n, 17 + n);
        res.writeHead(200, { "content-type": "image/png" });
        res.end(body);
      }
    }
    expect([(await first).status, (await second).status]).toEqual([201, 201]);
    // Imports that end in a refusal or a failure hand their slot back as well: more of them than there are slots.
    for (let n = 0; n < 3; n++)
      expect((await importUrl(user("editor"), at("/missing.png"))).status).toBe(422);
    expect((await importUrl(user("editor"), at("/third.png"))).status).toBe(201);
  }, 30_000);

  it("a client that disconnects ends its fetch and hands its slot back at once, not after the time limit", async () => {
    let closed = 0;
    for (const path of ["/gone-1.png", "/gone-2.png"])
      routes.set(path, (_req, res) => {
        res.writeHead(200, { "content-type": "image/png", "content-length": "5000" });
        res.write(Buffer.alloc(100, 1));
        res.on("close", () => void closed++);
      });
    serve("/after.png", await png(19, 19));
    const clients = [new AbortController(), new AbortController()];
    const pending = clients.map((client, n) =>
      importUrl(user("editor"), at(`/gone-${n + 1}.png`), ws, client.signal).catch((error: unknown) => error),
    );
    await until(() => asked.length === 2);
    for (const client of clients) client.abort();
    await until(() => closed === 2);
    expect((await importUrl(user("editor"), at("/after.png"))).status).toBe(201);
    await Promise.all(pending);
  }, 30_000);
});

describe("a fetch that fails is fetch_failed, whatever failed", () => {
  const FAILS: [string, () => Promise<string>][] = [
    ["a host that answers 404", async () => at("/missing.png")],
    [
      "a host that answers 500",
      async () => {
        routes.set("/broken.png", (_req, res) => {
          res.writeHead(500);
          res.end("failed");
        });
        return at("/broken.png");
      },
    ],
    [
      "a host that drops the connection",
      async () => {
        routes.set("/drop.png", (req) => req.socket.destroy());
        return at("/drop.png");
      },
    ],
    [
      "a port nobody listens on",
      async () => {
        const closed = createServer();
        const free = await listenLoopback(closed);
        await new Promise<void>((done) => closed.close(() => done()));
        operator = policy({ ports: [port, free] });
        return `http://127.0.0.1:${free}/a.png`;
      },
    ],
  ];
  it.each(FAILS)("%s", async (_row, urlOf) => {
    const url = await urlOf();
    const before = await snapshot();
    expect(await refusal(await importUrl(user("editor"), url))).toEqual([
      422,
      "unprocessable_content",
      "fetch_failed",
    ]);
    expect((await assets()).length).toBe(before.rows);
  });
});
