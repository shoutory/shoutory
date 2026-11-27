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

// The Bot API as core.telegram.org/bots/api documents it (read 2026-11-27): every method is a POST to
// /bot<token>/<method> and answers `{ok, result}` or `{ok:false, error_code, description, parameters?}`. The token is a
// path segment, so the simulator never writes a path into a log. `deleteMessage` of a message that is already gone
// answers 200 (the answer recorded live earlier; to be recorded again against the real service).

export interface TelegramSimulator extends Simulator {
  issueToken(): string;
  arm(operation: MatrixOperation | "upload", fault: MatrixFault): void;
  stored(): readonly StoredPost[];
  /** A person writes in a chat the bot is in; `channel` posts reach the bot as channel posts. */
  say(chat: { id: number; type: "channel" | "supergroup"; title: string }, text: string): void;
  /** What `getChatMember` answers for the bot in a chat (an administrator by default). */
  setMember(chatId: number, member: Readonly<Record<string, unknown>>): void;
  setWebhook(url: string): void;
}

const BOT = { id: 777000, is_bot: true, first_name: "Shoutory Sim", username: "shoutory_sim_bot" };
const TEXT_LIMIT = 4096;
const CAPTION_LIMIT = 1024;
const PHOTO_LIMIT = 10_485_760;

interface Message {
  readonly externalId: string;
  readonly kind: "t" | "p" | "a";
  text: string;
}

interface State {
  readonly tokens: Set<string>;
  readonly messages: Map<string, Message>;
  readonly byId: Map<number, string>;
  readonly updates: { update_id: number; [key: string]: unknown }[];
  readonly members: Map<number, Readonly<Record<string, unknown>>>;
  readonly chats: Map<number, string>;
  webhook: string;
  nextMessage: number;
  nextUpdate: number;
}

const fail = (status: number, description: string, parameters?: unknown): SimReply => ({
  status,
  body: { ok: false, error_code: status, description, ...(parameters === undefined ? {} : { parameters }) },
});
const answer = (result: unknown): SimReply => ({ status: 200, body: { ok: true, result } });

interface Part {
  readonly name: string;
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
    const name = /name="([^"]*)"/.exec(part.subarray(0, split).toString("utf8"))?.[1];
    if (name !== undefined) parts.push({ name, bytes: Buffer.from(part.subarray(split + 4)) });
    at = next;
  }
  return parts;
}

type Fields = Readonly<Record<string, unknown>>;

function fieldsOf(request: { headers: Readonly<Record<string, string>>; body: Buffer }): {
  fields: Fields;
  files: Map<string, Buffer>;
} {
  if ((request.headers["content-type"] ?? "").startsWith("application/json")) {
    return { fields: JSON.parse(request.body.toString("utf8")) as Fields, files: new Map() };
  }
  const parts = partsOf(request);
  const files = new Map(parts.map((part) => [part.name, part.bytes]));
  return {
    fields: Object.fromEntries(parts.map((part) => [part.name, part.bytes.toString("utf8")])),
    files,
  };
}

const authorized =
  (
    state: State,
    run: (fields: Fields, files: Map<string, Buffer>, effect: () => void) => SimReply,
  ): Handler =>
  (request, { effect }) => {
    const token = (request.params.bot ?? "").replace(/^bot/, "");
    if (!state.tokens.has(token)) return fail(401, "Unauthorized");
    const { fields, files } = fieldsOf(request);
    return run(fields, files, effect);
  };

function store(state: State, kind: Message["kind"], text: string, count: number, chatId: number): unknown[] {
  const ids = Array.from({ length: count }, () => state.nextMessage++);
  const externalId = `${kind}:${ids.join(",")}`;
  state.messages.set(externalId, { externalId, kind, text });
  for (const id of ids) state.byId.set(id, externalId);
  return ids.map((id) => ({ message_id: id, chat: { id: chatId }, date: 1 }));
}

const chatOf = (fields: Fields): number => Number(fields.chat_id);

function sendMessage(state: State): Handler {
  return authorized(state, (fields, _files, effect) => {
    const text = String(fields.text ?? "");
    if (text === "") return fail(400, "Bad Request: message text is empty");
    if ([...text].length > TEXT_LIMIT) return fail(400, "Bad Request: message is too long");
    effect();
    return answer(store(state, "t", text, 1, chatOf(fields))[0]);
  });
}

function sendPhoto(state: State): Handler {
  return authorized(state, (fields, files, effect) => {
    const caption = String(fields.caption ?? "");
    const photo = files.get("photo");
    if (photo === undefined) return fail(400, "Bad Request: wrong file identifier/HTTP URL specified");
    if (photo.length > PHOTO_LIMIT) return fail(400, "Bad Request: file is too big");
    if (caption.length > CAPTION_LIMIT) return fail(400, "Bad Request: message caption is too long");
    effect();
    return answer(store(state, "p", caption, 1, chatOf(fields))[0]);
  });
}

function sendMediaGroup(state: State): Handler {
  return authorized(state, (fields, files, effect) => {
    const group = JSON.parse(String(fields.media ?? "[]")) as { media: string; caption?: string }[];
    if (group.length < 2 || group.length > 10) return fail(400, "Bad Request: wrong number of files");
    const attached = group.every((item) => files.has(item.media.replace("attach://", "")));
    if (!attached) return fail(400, "Bad Request: wrong file identifier/HTTP URL specified");
    effect();
    return answer(store(state, "a", group[0]?.caption ?? "", group.length, chatOf(fields)));
  });
}

const messageOf = (state: State, fields: Fields): Message | undefined => {
  const externalId = state.byId.get(Number(fields.message_id));
  return externalId === undefined ? undefined : state.messages.get(externalId);
};

function edit(state: State, field: "text" | "caption"): Handler {
  return authorized(state, (fields, _files, effect) => {
    const message = messageOf(state, fields);
    if (message === undefined) return fail(400, "Bad Request: message to edit not found");
    const text = String(fields[field] ?? "");
    if (text === message.text) return fail(400, "Bad Request: message is not modified");
    message.text = text;
    effect();
    return answer({ message_id: Number(fields.message_id), chat: { id: chatOf(fields) }, date: 1 });
  });
}

function remove(state: State): Handler {
  return authorized(state, (fields, _files, effect) => {
    const id = Number(fields.message_id);
    const externalId = state.byId.get(id);
    if (externalId === undefined) return answer(true);
    state.byId.delete(id);
    if (![...state.byId.values()].includes(externalId)) state.messages.delete(externalId);
    effect();
    return answer(true);
  });
}

function getUpdates(state: State): Handler {
  return authorized(state, (fields) => {
    if (state.webhook !== "")
      return fail(409, "Conflict: can't use getUpdates method while webhook is active");
    const offset = Number(fields.offset ?? 0);
    state.updates.splice(
      0,
      state.updates.length,
      ...state.updates.filter((item) => item.update_id >= offset),
    );
    return answer(state.updates.slice(0, Number(fields.limit ?? 100)));
  });
}

// Telegram has no read of a message and takes no upload apart from a send, so the matrix arms neither.
const ROUTES: Readonly<Partial<Record<MatrixOperation | "upload", string>>> = {
  commit: "POST /:bot/sendMessage",
  delete: "POST /:bot/deleteMessage",
  edit: "POST /:bot/editMessageText",
};

const DESCRIPTIONS: Readonly<Record<number, string>> = {
  401: "Unauthorized",
  403: "Forbidden: bot was kicked from the channel chat",
  409: "Conflict: terminated by other getUpdates request",
  413: "Request Entity Too Large",
  429: "Too Many Requests: retry after 7",
};

function answerTo(fault: MatrixFault) {
  if (fault.kind !== "respond") return fault;
  const seconds =
    fault.retryAfter !== undefined && /^-?\d+$/.test(fault.retryAfter) ? Number(fault.retryAfter) : undefined;
  const description =
    fault.status === 400
      ? `Bad Request: ${fault.providerCode ?? "bad request"}`
      : (DESCRIPTIONS[fault.status] ?? "Internal Server Error");
  return {
    kind: "respond" as const,
    status: fault.status,
    body: {
      ok: false,
      error_code: fault.status,
      description,
      ...(seconds === undefined ? {} : { parameters: { retry_after: seconds } }),
      ...(fault.echoId === undefined ? {} : { id: fault.echoId }),
    },
    ...(fault.retryAfter === undefined ? {} : { headers: { "retry-after": fault.retryAfter } }),
    ...(fault.afterEffect === undefined ? {} : { afterEffect: fault.afterEffect }),
  };
}

export async function startTelegramSimulator(): Promise<TelegramSimulator> {
  const state: State = {
    tokens: new Set(),
    messages: new Map(),
    byId: new Map(),
    updates: [],
    members: new Map(),
    chats: new Map(),
    webhook: "",
    nextMessage: 100,
    nextUpdate: 1,
  };
  const simulator = await startSimulator({
    "POST /:bot/getMe": authorized(state, () => answer(BOT)),
    "POST /:bot/getWebhookInfo": authorized(state, () => answer({ url: state.webhook })),
    "POST /:bot/getChatMember": authorized(state, (fields) =>
      answer(
        state.members.get(chatOf(fields)) ?? { status: "administrator", can_post_messages: true, user: BOT },
      ),
    ),
    // getChat answers the chat's type; a chat nobody has written in is a supergroup.
    "POST /:bot/getChat": authorized(state, (fields) =>
      answer({ id: chatOf(fields), type: state.chats.get(chatOf(fields)) ?? "supergroup" }),
    ),
    "POST /:bot/getUpdates": getUpdates(state),
    "POST /:bot/sendMessage": sendMessage(state),
    "POST /:bot/sendPhoto": sendPhoto(state),
    "POST /:bot/sendMediaGroup": sendMediaGroup(state),
    "POST /:bot/editMessageText": edit(state, "text"),
    "POST /:bot/editMessageCaption": edit(state, "caption"),
    "POST /:bot/deleteMessage": remove(state),
  });
  let issued = 0;
  return {
    ...simulator,
    issueToken(): string {
      const token = `${BOT.id}:simulator-token-${++issued}`;
      state.tokens.add(token);
      return token;
    },
    arm(operation, fault): void {
      const route = ROUTES[operation];
      if (route === undefined) throw new Error(`the Telegram simulator plays no ${operation} fault`);
      simulator.faults.failNext(route, answerTo(fault));
    },
    stored: () => [...state.messages.values()].map(({ externalId, text }) => ({ externalId, text })),
    say(chat, text): void {
      const post = { text, chat };
      state.chats.set(chat.id, chat.type);
      const key = chat.type === "channel" ? "channel_post" : "message";
      state.updates.push({ update_id: state.nextUpdate++, [key]: post });
    },
    setMember: (chatId, member) => void state.members.set(chatId, member),
    setWebhook: (url) => {
      state.webhook = url;
    },
  };
}
