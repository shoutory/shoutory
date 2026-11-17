import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { Refusal } from "../errors/refusal.js";
import { csrf } from "../security/csrf.js";

export interface AppEnv {
  Variables: { requestId: string; clientAddress: string };
}
export type App = OpenAPIHono<AppEnv>;

/** The closed list of route policies. The authentication slice adds `session` and `step_up`, the API-key slice its own. */
const POLICIES = ["public"] as const;
type Policy = (typeof POLICIES)[number];

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
  /** A returned `Response` is sent as is; anything else is wrapped as `{ data }`. */
  readonly handler: (input: Input<B, Q, P>) => unknown;
}

interface RouteState {
  readonly publicOrigin: string;
  readonly routes: RegisteredRoute[];
}
const states = new WeakMap<App, RouteState>();

/** Called once by `createApp`: the public origin the CSRF check of every route compares with. */
export function initRoutes(app: App, publicOrigin: string): void {
  states.set(app, { publicOrigin, routes: [] });
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
  const middleware: MiddlewareHandler[] = [csrf(state.publicOrigin)];
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
      const result = await spec.handler({
        body: (spec.body ? validated(c, "json") : undefined) as Input<B, Q, P>["body"],
        query: validated(c, "query") as Input<B, Q, P>["query"],
        params: (spec.params ? validated(c, "param") : undefined) as Input<B, Q, P>["params"],
        clientAddress: c.get("clientAddress"),
        c,
      });
      return result instanceof Response ? result : c.json({ data: result ?? null }, 200);
    }) as never,
  );
  state.routes.push({
    method: spec.method.toUpperCase(),
    path: spec.path.replaceAll(/\/{(.+?)}/g, "/:$1"),
    policy: spec.policy,
    looseQuery: spec.looseQuery === true,
  });
}
