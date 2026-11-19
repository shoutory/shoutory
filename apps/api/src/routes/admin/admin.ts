import { flags } from "@shoutory/core/flags";
import type { TenantTx } from "@shoutory/db/context";
import type { Context } from "hono";
import { z } from "zod";
import type { AuthService } from "../../auth/auth.js";
import { Refusal } from "../../errors/refusal.js";
import { loadFlags } from "../../flags/load.js";
import { type App, type AppEnv, defineRoute, type InUserTx, type RouteAuth } from "../define-route.js";

// The instance admin routes behind the flag and sign-up screens. Only an instance admin reaches them: the first
// call of every handler asks `instance_admin_check` and anyone else is told the route does not exist. A write also
// needs a recent step-up and is audited by its definer.

const flagParams = z.strictObject({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_-]*$/)
    .max(64),
});
const overrideBody = z.strictObject({ on: z.boolean().nullable() });
const signupBody = z.strictObject({ value: z.boolean() });

/** Runs `run` in the caller's transaction once the caller is shown to be an instance admin. */
const asAdmin = <T>(inUserTx: InUserTx, run: (tx: TenantTx) => Promise<T>): Promise<T> =>
  inUserTx(async (tx) => {
    const check = await tx.query<{ ok: boolean }>("SELECT app.instance_admin_check() AS ok");
    if (check.rows[0]?.ok !== true) throw new Refusal("not_found", "the caller is not an instance admin");
    return run(tx);
  });

function registerReads(app: App): void {
  defineRoute(app, {
    method: "get",
    path: "/api/v1/admin/flags",
    policy: "session",
    access: "user",
    handler: ({ inUserTx }) =>
      asAdmin(inUserTx, async (tx) => {
        const loaded = await loadFlags(tx);
        const ctx = { snapshot: loaded.snapshot };
        return loaded.flags.map((flag) => ({
          key: flag.key,
          description: flag.description,
          owner: flag.owner,
          remove_by: flag.removeBy,
          default_on: flag.defaultOn,
          instance_override: flag.instanceOverride,
          effective: flags.isOn(ctx, flag.key),
        }));
      }),
  });
  defineRoute(app, {
    method: "get",
    path: "/api/v1/admin/settings",
    policy: "session",
    access: "user",
    handler: ({ inUserTx }) =>
      asAdmin(
        inUserTx,
        async (tx) => (await tx.query("SELECT key, value FROM app.instance_settings_read()")).rows,
      ),
  });
}

/**
 * A write: the admin check comes first and the step-up second, so a non-admin never learns that the route exists from
 * a step-up refusal. (The `step_up` route policy would run before the handler and answer 403 to a non-admin.)
 */
async function asAdminWrite<T>(
  auth: RouteAuth,
  c: Context<AppEnv>,
  inUserTx: InUserTx,
  run: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  await asAdmin(inUserTx, async () => undefined);
  if (!(await auth.hasStepUp(c.get("session")))) {
    throw new Refusal("step_up_required", "no authentication in the last ten minutes");
  }
  return asAdmin(inUserTx, run);
}

function registerWrites(app: App, auth: AuthService): void {
  const ipHmac = auth.ipHmac;
  defineRoute(app, {
    method: "put",
    path: "/api/v1/admin/flags/{key}/override",
    policy: "session",
    access: "user",
    params: flagParams,
    body: overrideBody,
    handler: ({ c, params, body, clientAddress, inUserTx }) =>
      asAdminWrite(auth, c, inUserTx, async (tx) => {
        await tx.query("SELECT app.feature_flag_override_set($1, $2, $3, $4)", [
          params.key,
          body.on,
          c.get("requestId"),
          ipHmac(clientAddress),
        ]);
        return { key: params.key, on: body.on };
      }),
  });
  defineRoute(app, {
    method: "put",
    path: "/api/v1/admin/settings/signup_enabled",
    policy: "session",
    access: "user",
    body: signupBody,
    handler: ({ c, body, clientAddress, inUserTx }) =>
      asAdminWrite(auth, c, inUserTx, async (tx) => {
        await tx.query("SELECT app.instance_setting_set('signup_enabled', $1::jsonb, $2, $3)", [
          JSON.stringify(body.value),
          c.get("requestId"),
          ipHmac(clientAddress),
        ]);
        return { key: "signup_enabled", value: body.value };
      }),
  });
}

export function registerAdmin(app: App, auth: AuthService): void {
  registerReads(app);
  registerWrites(app, auth);
}
