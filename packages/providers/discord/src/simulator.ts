import type {
  MatrixFault,
  MatrixOperation,
  StoredPost,
} from "@shoutory/provider-sdk/conformance/fault-matrix";
import {
  type Handler,
  type SimReply,
  type Simulator,
  startSimulator,
} from "@shoutory/testkit/simulator/server";

// A Discord webhook as docs.discord.com/developers documents it (all read 2026-11-27): `resources/webhook` (execute with
// `wait` answers the message and without it 204; get with the token answers the webhook; get, edit and delete of a message
// of the same webhook; `content` up to 2000 characters, at least one of content or file), `topics/opcodes-and-status-codes`
// (10008 unknown message, 10015 unknown webhook, 50027 invalid webhook token, 50006 empty message, 50035 invalid form
// body, 40005 request too large), `topics/rate-limits` (429 body `retry_after` and the `Retry-After` header) and `reference`
// (20 MiB per file, multipart with `payload_json` and `files[n]`).

const WEBHOOK_ID = "123456789012345678";
const WEBHOOK_TOKEN = "simulated-webhook-token-1";
const CHANNEL_ID = "323456789012345678";
const MAX_CONTENT = 2000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export interface SentFile {
  readonly filename: string;
  readonly bytes: Buffer;
  readonly description: string | null;
}

export interface DiscordSimulator extends Simulator {
  /** The webhook URL a person would paste, on the given host. */
  urlFor(host?: string): string;
  reset(): void;
  arm(operation: MatrixOperation, fault: MatrixFault): void;
  stored(): readonly StoredPost[];
  files(): readonly SentFile[];
}

interface Message {
  readonly id: string;
  readonly content: string;
}

interface State {
  messages: Map<string, Message>;
  files: SentFile[];
}

const fail = (status: number, code: number, message: string): SimReply => ({
  status,
  body: { code, message },
});
const UNKNOWN_WEBHOOK = (): SimReply => fail(404, 10015, "Unknown Webhook");
const UNKNOWN_MESSAGE = (): SimReply => fail(404, 10008, "Unknown Message");

function refusedWebhook(params: Readonly<Record<string, string>>): SimReply | undefined {
  if (params.id !== WEBHOOK_ID) return UNKNOWN_WEBHOOK();
  return params.token === WEBHOOK_TOKEN ? undefined : fail(401, 50027, "Invalid Webhook Token");
}

interface Part {
  readonly name: string;
  readonly filename: string | undefined;
  readonly bytes: Buffer;
}

// A multipart/form-data body (RFC 7578): parts split on the boundary line, each with its headers, a blank line and the content.
function partsOf(request: { headers: Readonly<Record<string, string>>; body: Buffer }): Part[] {
  const boundary = /boundary=([^;]+)/.exec(request.headers["content-type"] ?? "")?.[1];
  if (boundary === undefined) return [];
  const parts: Part[] = [];
  const marker = Buffer.from(`--${boundary}`);
  let at = request.body.indexOf(marker);
  while (at !== -1) {
    const start = at + marker.length;
    const next = request.body.indexOf(marker, start);
    if (next === -1) break;
    const part = request.body.subarray(start + 2, next - 2);
    const split = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, split).toString("utf8");
    const name = /name="([^"]*)"/.exec(head)?.[1];
    if (name !== undefined) {
      parts.push({
        name,
        filename: /filename="([^"]*)"/.exec(head)?.[1],
        bytes: Buffer.from(part.subarray(split + 4)),
      });
    }
    at = next;
  }
  return parts;
}

interface Payload {
  readonly content: string;
  readonly attachments: readonly { readonly id: number; readonly description?: string }[];
}

const textToObject = (text: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }
};

function payloadOf(request: { headers: Readonly<Record<string, string>>; body: Buffer }) {
  const multipart = (request.headers["content-type"] ?? "").startsWith("multipart/form-data");
  const parts = multipart ? partsOf(request) : [];
  const json = multipart
    ? (parts.find((part) => part.name === "payload_json")?.bytes.toString("utf8") ?? "{}")
    : request.body.toString("utf8");
  const fields = textToObject(json);
  const attachments = Array.isArray(fields.attachments) ? (fields.attachments as Payload["attachments"]) : [];
  const files = parts
    .filter((part) => part.name.startsWith("files[") && part.filename !== undefined)
    .map((part, index): SentFile => {
      const meta = attachments.find((attachment) => attachment.id === index);
      return { filename: part.filename ?? "", bytes: part.bytes, description: meta?.description ?? null };
    });
  return { content: typeof fields.content === "string" ? fields.content : "", files };
}

const execute =
  (state: State): Handler =>
  (request, { effect }) => {
    const refused = refusedWebhook(request.params);
    if (refused) return refused;
    const { content, files } = payloadOf(request);
    if (content === "" && files.length === 0) return fail(400, 50006, "Cannot send an empty message");
    if (content.length > MAX_CONTENT) return fail(400, 50035, "Invalid Form Body");
    if (files.some((file) => file.bytes.length > MAX_FILE_BYTES)) {
      return fail(413, 40005, "Request entity too large");
    }
    const message = { id: `2234567890123${String(state.messages.size + 1).padStart(5, "0")}`, content };
    state.messages.set(message.id, message);
    state.files.push(...files);
    effect();
    return request.query.get("wait") === "true"
      ? { status: 200, body: { ...message, channel_id: CHANNEL_ID, webhook_id: WEBHOOK_ID } }
      : { status: 204 };
  };

const readWebhook =
  (state: State): Handler =>
  (request) =>
    refusedWebhook(request.params) ?? {
      status: 200,
      // Discord includes the token in this answer; an adapter that copies it into a result is caught by the tests.
      body: {
        id: WEBHOOK_ID,
        type: 1,
        name: "Simulated channel",
        channel_id: CHANNEL_ID,
        token: WEBHOOK_TOKEN,
      },
    };

const messageRoute =
  (
    state: State,
    act: (message: Message, request: Parameters<Handler>[0]) => SimReply,
    effects: boolean,
  ): Handler =>
  (request, { effect }) => {
    const refused = refusedWebhook(request.params);
    if (refused) return refused;
    const message = state.messages.get(request.params.message ?? "");
    if (!message) return UNKNOWN_MESSAGE();
    const reply = act(message, request);
    if (effects) effect();
    return reply;
  };

const ROUTES: Readonly<Record<MatrixOperation, string>> = {
  commit: "POST /api/webhooks/:id/:token",
  readBack: "GET /api/webhooks/:id/:token/messages/:message",
  delete: "DELETE /api/webhooks/:id/:token/messages/:message",
  edit: "PATCH /api/webhooks/:id/:token/messages/:message",
};

// The codes the docs give for each status; the matrix plays the status and this adds what Discord answers with it.
function answerTo(fault: MatrixFault) {
  if (fault.kind !== "respond") return fault;
  const documented: Readonly<Record<number, number>> = { 401: 50027, 403: 50013, 413: 40005, 400: 50035 };
  const seconds =
    fault.retryAfter !== undefined && /^\d+$/.test(fault.retryAfter) ? Number(fault.retryAfter) : undefined;
  const given = Number(fault.providerCode);
  const code = Number.isInteger(given) ? given : documented[fault.status];
  return {
    kind: "respond" as const,
    status: fault.status,
    body: {
      message: "Fault",
      ...(code === undefined ? {} : { code }),
      ...(seconds === undefined ? {} : { retry_after: seconds, global: false }),
      ...(fault.echoId === undefined ? {} : { id: fault.echoId }),
    },
    ...(fault.retryAfter === undefined ? {} : { headers: { "retry-after": fault.retryAfter } }),
    ...(fault.afterEffect === undefined ? {} : { afterEffect: fault.afterEffect }),
  };
}

export async function startDiscordSimulator(): Promise<DiscordSimulator> {
  const state: State = { messages: new Map(), files: [] };
  const simulator = await startSimulator({
    [ROUTES.commit]: execute(state),
    "GET /api/webhooks/:id/:token": readWebhook(state),
    [ROUTES.readBack]: messageRoute(state, (message) => ({ status: 200, body: message }), false),
    [ROUTES.edit]: messageRoute(
      state,
      (message, request) => {
        const edited = {
          ...message,
          content: String(textToObject(request.body.toString("utf8")).content ?? ""),
        };
        state.messages.set(message.id, edited);
        return { status: 200, body: edited };
      },
      true,
    ),
    [ROUTES.delete]: messageRoute(
      state,
      (message) => {
        state.messages.delete(message.id);
        return { status: 204 };
      },
      true,
    ),
  });
  return {
    ...simulator,
    urlFor: (host = "discord.com") => `https://${host}/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
    reset(): void {
      state.messages = new Map();
      state.files = [];
      (simulator.requests as unknown[]).length = 0;
    },
    arm(operation, fault): void {
      simulator.faults.failNext(ROUTES[operation], answerTo(fault));
    },
    stored: () =>
      [...state.messages.values()].map((message) => ({ externalId: message.id, text: message.content })),
    files: () => state.files,
  };
}
