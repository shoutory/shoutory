import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS, type Permission } from "@shoutory/core/authz";
import type { AuthorizedScope } from "@shoutory/core/authz/scope";
import type { ErrorCode } from "@shoutory/core/errors";
import type { TenantTx } from "@shoutory/db/context";
import { type ScopeDenial, type ScopeRequest, withScope, withUser } from "@shoutory/db/context/scope";
import type { AppPool } from "@shoutory/db/pool";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AuthSession, SessionResolver } from "../auth/session-check.js";
import { Refusal } from "../errors/refusal.js";
import { csrf } from "../security/csrf.js";
import { definerRefusal } from "./definer-refusal.js";

export interface AppEnv {
  Variables: { requestId: string; clientAddress: string; session: AuthSession };
}
export type App = OpenAPIHono<AppEnv>;

/** The closed list of route policies. The API-key slice adds its own. */
const POLICIES = ["public", "session", "step_up"] as const;
type Policy = (typeof POLICIES)[number];

/** What a `session` or `step_up` route needs from the authentication service. */
export interface RouteAuth {
  readonly resolveSession: SessionResolver;
  /** Refuses with `step_up_required` unless the session proved its identity again in the last ten minutes. */
  readonly requireStepUp: (session: AuthSession) => Promise<void>;
}

/**
 * What data a route may reach. `none` is for a public route; `user` needs a signed-in user and holds a transaction only inside `inUserTx`; a workspace
 * access names the path parameter that holds the workspace id and the permission the caller needs there (none: any
 * member). The handler never sees a workspace id that did not come through this declaration.
 */
export type Access =
  | "none"
  | "user"
  | { readonly workspace: string; readonly permission?: Permission; readonly split?: true };

/**
 * What a `split` workspace route calls instead of holding one transaction: each call is its own short scoped
 * transaction (read, or write), authorized like the single one, so the handler may call outside the database between
 * them (AGENTS 3.7). A denial of the scope is an answer, and the callback does not run.
 */
type Scoped = <T>(write: boolean, run: (tx: TenantTx, scope: AuthorizedScope) => Promise<T>) => Promise<T>;

export interface RegisteredRoute {
  readonly method: string;
  readonly path: string;
  readonly policy: Policy;
  readonly access: Access;
  readonly looseQuery: boolean;
  /** `web`: the web-client CSRF check runs; `token`: the path token is the credential (the one-click unsubscribe). */
  readonly csrf: "web" | "token";
}

const MAX_BODY_BYTES = 1024 * 1024;
type Shape = z.ZodType<Record<string, unknown>>;
const noInput = z.strictObject({});

/**
 * What a `user` route may call: it opens a principal-only transaction when called, and nothing is held before. `run`
 * calls only definers and makes no outbound call (AGENTS 3.7).
 */
export type InUserTx = <T>(run: (tx: TenantTx) => Promise<T>) => Promise<T>;

interface Input<B, Q, P, A extends Access> {
  readonly body: B extends Shape ? z.infer<B> : undefined;
  readonly query: z.infer<Q & Shape>;
  readonly params: P extends Shape ? z.infer<P> : undefined;
  readonly clientAddress: string;
  readonly c: Context<AppEnv>;
  /** The transaction the scope narrowed; absent on a `none` or `user` route. */
  readonly tx: A extends "none" | "user" | { split: true } ? undefined : TenantTx;
  /** The proof of the workspace the route reached; present only on a workspace access that holds one transaction. */
  readonly scope: A extends { split: true }
    ? undefined
    : A extends { workspace: string }
      ? AuthorizedScope
      : undefined;
  /** The short scoped transactions of a `split` workspace access; absent on every other access. */
  readonly scoped: A extends { split: true } ? Scoped : undefined;
  /** The one way a `user` route reaches a definer; absent on every other access. */
  readonly inUserTx: A extends "user" ? InUserTx : undefined;
}

export interface RouteSpec<
  B extends Shape | undefined,
  Q extends Shape,
  P extends Shape | undefined,
  A extends Access,
> {
  readonly method: "get" | "post" | "put" | "patch" | "delete";
  readonly path: string;
  readonly policy: Policy;
  readonly access: A;
  readonly body?: B;
  /** Strict by default: an unknown query key is refused. */
  readonly query?: Q;
  /** The one opt-out of a strict query, for the SPA shell route; every other route refuses it at registration. */
  readonly looseQuery?: boolean;
  readonly params?: P;
  /** The route authenticates by its cookie alone: a request carrying an `Authorization` header is refused. */
  readonly cookieOnly?: boolean;
  /**
   * The one opt-out of the web-client CSRF check (R321), only for a `public` route whose path token is the credential:
   * a mail client's one-click POST carries neither the origin nor the client header, and no ambient credential.
   */
  readonly csrf?: "token";
  /** The success status; 200 unless the route creates something. */
  readonly status?: 200 | 201;
  /** A returned `Response` is sent as is; anything else is wrapped as `{ data }`. */
  readonly handler: (input: Input<B, Q, P, A>) => unknown;
}

interface RouteState {
  readonly publicOrigin: string;
  readonly auth: RouteAuth;
  readonly pool: AppPool;
  readonly routes: RegisteredRoute[];
}
const states = new WeakMap<App, RouteState>();

/**
 * Called once by `createApp`: the public origin the CSRF check compares with, the session reader of the policies and
 * the pool the scoped routes run on.
 */
export function initRoutes(app: App, publicOrigin: string, auth: RouteAuth, pool: AppPool): void {
  states.set(app, { publicOrigin, auth, pool, routes: [] });
}

/** A cookie-only route never reads `Authorization`, so any value in it is a refused credential, not an exemption. */
const refuseAuthorization: MiddlewareHandler = async (c, next) => {
  if (c.req.header("authorization") !== undefined) {
    throw new Refusal("unauthenticated", "this route authenticates by cookie only");
  }
  await next();
};

/**
 * The `session` policy. It runs after the input is validated (a malformed request is a 400 whoever sends it) and
 * before the handler; the cookies a sliding refresh produced are returned to ride the answer.
 */
async function authenticate(auth: RouteAuth, c: Context<AppEnv>, policy: Policy): Promise<readonly string[]> {
  const found = await auth.resolveSession(c.req.raw.headers);
  if (!found) throw new Refusal("unauthenticated", "no valid session");
  c.set("session", found.session);
  if (policy === "step_up") await auth.requireStepUp(found.session);
  return found.cookies;
}

/** Every route registered through `defineRoute`, for the contract test and the strict-input test. */
export function registeredRoutes(app: App): readonly RegisteredRoute[] {
  return states.get(app)?.routes ?? [];
}

const JSON_TYPE = /^application\/json\s*(;|$)/i;

/** The route declares JSON, so a body (or its absence) with any other media type is a 415, never skipped. */
const requireJson: MiddlewareHandler = async (c, next) => {
  if (!JSON_TYPE.test(c.req.header("content-type") ?? "")) {
    throw new Refusal("unsupported_media_type", "the body is not application/json");
  }
  await next();
};

function tooLarge(): never {
  throw new Refusal("payload_too_large", "the body is over the limit");
}

type ValidTarget = "json" | "query" | "param";
// Hono types `valid` per route; this wrapper is the one place that reads the validated data untyped.
const validated = (c: Context<AppEnv>, target: ValidTarget): unknown =>
  (c.req as unknown as { valid(target: ValidTarget): unknown }).valid(target);

/** Refuses at registration a schema that would let an unknown key through (Zod 4: an object whose catchall is never). */
function assertStrict(where: string, schema: Shape | undefined): void {
  if (!schema) return;
  const def = schema._zod.def as z.core.$ZodObjectDef;
  if (def.type !== "object" || def.catchall?._zod.def.type !== "never") {
    throw new Error(`defineRoute: the ${where} schema must be a strict object (z.strictObject)`);
  }
}

/** Refuses at registration an access that could reach data without a principal, a workspace or a known permission. */
function assertAccess(spec: RouteSpec<Shape | undefined, Shape, Shape | undefined, Access>): void {
  const { access, policy, method, params } = spec;
  if (spec.csrf === "token" && (policy !== "public" || method !== "post" || !params)) {
    throw new Error(
      `defineRoute: ${method} ${spec.path}: the token CSRF opt-out is for a public POST with a token`,
    );
  }
  const problem = accessProblem(access, policy, method, params);
  if (problem) throw new Error(`defineRoute: ${method} ${spec.path}: ${problem}`);
}

function accessProblem(
  access: Access,
  policy: Policy,
  method: string,
  params: Shape | undefined,
): string | undefined {
  if (access === "none") return policy === "public" ? undefined : "access none is only for a public route";
  if (policy === "public") return "a public route has no principal, so its access is none";
  if (access === "user") return undefined;
  if (typeof access !== "object" || access === null || typeof access.workspace !== "string") {
    return "access is none, user or a workspace access";
  }
  const shape = (params?._zod.def as z.core.$ZodObjectDef | undefined)?.shape ?? {};
  if (!Object.hasOwn(shape, access.workspace))
    return `the workspace parameter ${access.workspace} is not in params`;
  if (access.permission === undefined) {
    if (access.split) return "a split access picks read or write per call, so it needs a permission";
    return method === "get" ? undefined : "a workspace access that changes data needs a permission";
  }
  return PERMISSIONS.includes(access.permission) ? undefined : "unknown permission";
}

const DENIALS: Readonly<Record<ScopeDenial, ErrorCode>> = {
  not_found: "not_found",
  forbidden: "forbidden",
  invalid: "validation_failed",
  limit_reached: "limit_reached",
};

const userTx =
  (pool: AppPool, userId: string): InUserTx =>
  async (run) => {
    try {
      return await withUser(pool, userId, run);
    } catch (error) {
      throw definerRefusal(error) ?? error;
    }
  };

type Base = Omit<Input<unknown, Shape, unknown, Access>, "tx" | "scope" | "scoped" | "inUserTx">;

function scopeRequest(
  access: { readonly workspace: string; readonly permission?: Permission },
  params: Record<string, unknown> | undefined,
  method: string,
): ScopeRequest {
  const target = String(params?.[access.workspace]);
  const write = method !== "get";
  return access.permission === undefined
    ? { target, write }
    : { target, permission: access.permission, write };
}

/**
 * Runs the handler as its access declares. `none` and `user` mean no transaction and no scope: a user route may call
 * outside the database, and holds a connection only inside `inUserTx`. The workspace comes only from the declared path
 * parameter; a denial of the scope is an answer, and the handler does not run.
 */
async function runScoped(
  state: RouteState,
  spec: RouteSpec<Shape | undefined, Shape, Shape | undefined, Access>,
  base: Base,
  session: AuthSession,
): Promise<unknown> {
  const { access } = spec;
  if (access === "none" || access === "user") {
    const inUserTx = access === "user" ? userTx(state.pool, session.userId) : undefined;
    return spec.handler({ ...base, tx: undefined, scope: undefined, inUserTx } as never);
  }
  const params = base.params as Record<string, unknown> | undefined;
  const entered = async <T>(
    method: string,
    run: (tx: TenantTx, scope: AuthorizedScope) => Promise<T>,
  ): Promise<T> => {
    const outcome = await withScope(state.pool, session.userId, scopeRequest(access, params, method), run);
    if (!outcome.ok) throw new Refusal(DENIALS[outcome.denial], `scope denied: ${outcome.denial}`);
    return outcome.value;
  };
  if (access.split) {
    const scoped: Scoped = (write, run) => entered(write ? "post" : "get", run);
    return spec.handler({ ...base, tx: undefined, scope: undefined, scoped, inUserTx: undefined } as never);
  }
  return entered(spec.method, (tx, scope) =>
    Promise.resolve(spec.handler({ ...base, tx, scope, inUserTx: undefined } as never)),
  );
}

/**
 * The headers the policy adds to an answer. An answer for a signed-in caller is that caller's, so a shared cache must
 * never replay it to another: it is `no-store` unless the handler chose a value. The cookies a sliding refresh produced
 * ride along, but a cookie the handler already set (a sign-out's expiry) is not overridden by them.
 */
function withPolicyHeaders(response: Response, policy: Policy, cookies: readonly string[]): Response {
  if (policy !== "public" && !response.headers.has("cache-control")) {
    response.headers.set("cache-control", "no-store");
  }
  const set = new Set(response.headers.getSetCookie().map((line) => line.split("=")[0]));
  for (const cookie of cookies) {
    if (!set.has(cookie.split("=")[0])) response.headers.append("set-cookie", cookie);
  }
  return response;
}

/**
 * The only way to add a route. The policy and the access are declared, CSRF and the body limit run first, every input
 * schema is a strict object and a failed validation answers with the error envelope.
 */
export function defineRoute<
  B extends Shape | undefined = undefined,
  Q extends Shape = typeof noInput,
  P extends Shape | undefined = undefined,
  A extends Access = Access,
>(app: App, spec: RouteSpec<B, Q, P, A>): void {
  const state = states.get(app);
  if (!state) throw new Error("createApp must run before defineRoute");
  assertStrict("body", spec.body);
  if (!spec.looseQuery) assertStrict("query", spec.query);
  assertStrict("params", spec.params);
  assertAccess(spec as never);
  const middleware: MiddlewareHandler[] = [
    ...(spec.cookieOnly ? [refuseAuthorization] : []),
    ...(spec.csrf === "token" ? [] : [csrf(state.publicOrigin)]),
  ];
  if (spec.body) middleware.push(bodyLimit({ maxSize: MAX_BODY_BYTES, onError: tooLarge }), requireJson);
  const route = createRoute({
    method: spec.method,
    path: spec.path,
    middleware,
    request: {
      query: (spec.query ?? noInput) as never,
      ...(spec.params ? { params: spec.params as never } : {}),
      ...(spec.body
        ? { body: { required: true, content: { "application/json": { schema: spec.body as never } } } }
        : {}),
    },
    responses: { [spec.status ?? 200]: { description: "OK" } },
  });
  app.openapi(
    route as never,
    (async (c: Context<AppEnv>) => {
      const cookies = spec.policy === "public" ? [] : await authenticate(state.auth, c, spec.policy);
      const base = {
        body: spec.body ? validated(c, "json") : undefined,
        query: validated(c, "query"),
        params: spec.params ? validated(c, "param") : undefined,
        clientAddress: c.get("clientAddress"),
        c,
      };
      const result = await runScoped(state, spec as never, base as Base, c.get("session"));
      const response =
        result instanceof Response ? result : c.json({ data: result ?? null }, spec.status ?? 200);
      return withPolicyHeaders(response, spec.policy, cookies);
    }) as never,
  );
  state.routes.push({
    method: spec.method.toUpperCase(),
    path: spec.path.replaceAll(/\/{(.+?)}/g, "/:$1"),
    policy: spec.policy,
    access: spec.access,
    looseQuery: spec.looseQuery === true,
    csrf: spec.csrf ?? "web",
  });
}
