import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AuthSession, SessionResolver } from "../auth/session-check.js";
import { Refusal } from "../errors/refusal.js";
import { csrf } from "../security/csrf.js";

export interface AppEnv {
  Variables: { requestId: string; clientAddress: string; session: AuthSession };
}
export type App = OpenAPIHono<AppEnv>;

/** The closed list of route policies. The API-key slice adds its own. */
const POLICIES = ["public", "session"] as const;
type Policy = (typeof POLICIES)[number];

/** What a `session` route needs from the authentication service. */
export interface RouteAuth {
  readonly resolveSession: SessionResolver;
}

export interface RegisteredRoute {
  readonly method: string;
  readonly path: string;
  readonly policy: Policy;
  readonly looseQuery: boolean;
}

const MAX_BODY_BYTES = 1024 * 1024;
type Shape = z.ZodType<Record<string, unknown>>;
const noInput = z.strictObject({});

interface Input<B, Q, P> {
  readonly body: B extends Shape ? z.infer<B> : undefined;
  readonly query: z.infer<Q & Shape>;
  readonly params: P extends Shape ? z.infer<P> : undefined;
  readonly clientAddress: string;
  readonly c: Context<AppEnv>;
}

export interface RouteSpec<B extends Shape | undefined, Q extends Shape, P extends Shape | undefined> {
  readonly method: "get" | "post" | "put" | "patch" | "delete";
  readonly path: string;
  readonly policy: Policy;
  readonly body?: B;
  /** Strict by default: an unknown query key is refused. */
  readonly query?: Q;
  /** The one opt-out of a strict query, for the SPA shell route; every other route refuses it at registration. */
  readonly looseQuery?: boolean;
  readonly params?: P;
  /** The route authenticates by its cookie alone: a request carrying an `Authorization` header is refused. */
  readonly cookieOnly?: boolean;
  /** A returned `Response` is sent as is; anything else is wrapped as `{ data }`. */
  readonly handler: (input: Input<B, Q, P>) => unknown;
}

interface RouteState {
  readonly publicOrigin: string;
  readonly auth: RouteAuth;
  readonly routes: RegisteredRoute[];
}
const states = new WeakMap<App, RouteState>();

/** Called once by `createApp`: the public origin the CSRF check compares with, and the session reader of the policies. */
export function initRoutes(app: App, publicOrigin: string, auth: RouteAuth): void {
  states.set(app, { publicOrigin, auth, routes: [] });
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
async function authenticate(auth: RouteAuth, c: Context<AppEnv>): Promise<readonly string[]> {
  const found = await auth.resolveSession(c.req.raw.headers);
  if (!found) throw new Refusal("unauthenticated", "no valid session");
  c.set("session", found.session);
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

/**
 * The only way to add a route. The policy is declared, CSRF and the body limit run first, every input schema is
 * a strict object and a failed validation answers with the error envelope.
 */
export function defineRoute<
  B extends Shape | undefined = undefined,
  Q extends Shape = typeof noInput,
  P extends Shape | undefined = undefined,
>(app: App, spec: RouteSpec<B, Q, P>): void {
  const state = states.get(app);
  if (!state) throw new Error("createApp must run before defineRoute");
  assertStrict("body", spec.body);
  if (!spec.looseQuery) assertStrict("query", spec.query);
  assertStrict("params", spec.params);
  const middleware: MiddlewareHandler[] = [
    ...(spec.cookieOnly ? [refuseAuthorization] : []),
    csrf(state.publicOrigin),
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
    responses: { 200: { description: "OK" } },
  });
  app.openapi(
    route as never,
    (async (c: Context<AppEnv>) => {
      const cookies = spec.policy === "public" ? [] : await authenticate(state.auth, c);
      const result = await spec.handler({
        body: (spec.body ? validated(c, "json") : undefined) as Input<B, Q, P>["body"],
        query: validated(c, "query") as Input<B, Q, P>["query"],
        params: (spec.params ? validated(c, "param") : undefined) as Input<B, Q, P>["params"],
        clientAddress: c.get("clientAddress"),
        c,
      });
      const response = result instanceof Response ? result : c.json({ data: result ?? null }, 200);
      // A cookie the handler already set (a sign-out's expiry) is not overridden by the policy's refreshed one.
      const set = new Set(response.headers.getSetCookie().map((line) => line.split("=")[0]));
      for (const cookie of cookies) {
        if (!set.has(cookie.split("=")[0])) response.headers.append("set-cookie", cookie);
      }
      return response;
    }) as never,
  );
  state.routes.push({
    method: spec.method.toUpperCase(),
    path: spec.path.replaceAll(/\/{(.+?)}/g, "/:$1"),
    policy: spec.policy,
    looseQuery: spec.looseQuery === true,
  });
}
