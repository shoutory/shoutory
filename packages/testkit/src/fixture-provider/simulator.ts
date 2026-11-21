import type {
  MatrixFault,
  MatrixOperation,
  StoredPost,
} from "@shoutory/provider-sdk/conformance/fault-matrix";
import { z } from "zod";
import type { Fault } from "../simulator/faults.js";
import { type Handler, type SimReply, startSimulator } from "../simulator/server.js";

const POST = "/v1/posts";
const ROUTES: Record<MatrixOperation, string> = {
  commit: `POST ${POST}`,
  readBack: `GET ${POST}/:id`,
  delete: `DELETE ${POST}/:id`,
  edit: `PATCH ${POST}/:id`,
};

// The fixture network documents one error code per refusal; a 400 carries the code the test names.
const ERROR_CODES: Readonly<Record<number, string>> = {
  401: "grant_revoked",
  403: "target_refused",
  404: "not_found",
  409: "duplicate",
  413: "too_large",
  429: "rate_limited",
};

const postBody = z.strictObject({ text: z.string().max(10_000), replyTo: z.string().max(64).optional() });
const editBody = z.strictObject({ text: z.string().max(10_000) });

function jsonOf(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

const errorReply = (status: number, code: string, id?: string): SimReply => ({
  status,
  body: { error: { code, ...(id === undefined ? {} : { id }) } },
});

function toFault(fault: MatrixFault): Fault {
  if (fault.kind !== "respond") return fault;
  const { status, providerCode, echoId, retryAfter, afterEffect } = fault;
  const code = providerCode ?? ERROR_CODES[status] ?? "server_error";
  return {
    kind: "respond",
    ...errorReply(status, code, echoId),
    ...(retryAfter === undefined ? {} : { headers: { "retry-after": retryAfter } }),
    ...(afterEffect === undefined ? {} : { afterEffect }),
  };
}

function fixtureRoutes(posts: Map<string, StoredPost>) {
  const keys = new Map<string, string>();
  let counter = 0;

  const create: Handler = (request, { effect }) => {
    const parsed = postBody.safeParse(jsonOf(request.body));
    if (!parsed.success) return errorReply(400, "validation");
    const key = request.headers["idempotency-key"];
    const known = key === undefined ? undefined : keys.get(key);
    if (known !== undefined) return { status: 200, body: { id: known } };
    const id = `post-${++counter}`;
    posts.set(id, {
      externalId: id,
      text: parsed.data.text,
      ...(parsed.data.replyTo === undefined ? {} : { replyToExternalId: parsed.data.replyTo }),
    });
    if (key !== undefined) keys.set(key, id);
    effect();
    return { status: 201, body: { id } };
  };

  const existing = (id: string | undefined) => (id === undefined ? undefined : posts.get(id));
  return {
    [ROUTES.commit]: create,
    "POST /v1/validate": () => ({ status: 200, body: {} }),
    "GET /v1/account": () => ({ status: 200, body: { id: "account-1" } }),
    [ROUTES.readBack]: (request) => {
      const post = existing(request.params.id);
      return post
        ? { status: 200, body: { id: post.externalId, text: post.text } }
        : errorReply(404, "not_found");
    },
    [ROUTES.delete]: (request, { effect }) => {
      if (!posts.delete(request.params.id ?? "")) return errorReply(404, "not_found");
      effect();
      return { status: 200, body: {} };
    },
    [ROUTES.edit]: (request, { effect }) => {
      const post = existing(request.params.id);
      const parsed = editBody.safeParse(jsonOf(request.body));
      if (!post) return errorReply(404, "not_found");
      if (!parsed.success) return errorReply(400, "validation");
      posts.set(post.externalId, { ...post, text: parsed.data.text });
      effect();
      return { status: 200, body: { id: post.externalId } };
    },
  } satisfies Record<string, Handler>;
}

/** Starts the fixture network on a loopback port. It answers the fixture adapter and arms matrix faults. */
export async function startFixtureSimulator() {
  const posts = new Map<string, StoredPost>();
  const simulator = await startSimulator(fixtureRoutes(posts));
  return {
    url: simulator.url,
    close: () => simulator.close(),
    effects: () => simulator.effects(),
    settle: () => simulator.settle(),
    pending: () => simulator.faults.pending(),
    stored: (): readonly StoredPost[] => [...posts.values()],
    requestCount: () => simulator.requests.length,
    arm: (operation: MatrixOperation, fault: MatrixFault) =>
      simulator.faults.failNext(ROUTES[operation], toFault(fault)),
  };
}
