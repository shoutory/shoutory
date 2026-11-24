import { type App, defineRoute } from "../define-route.js";

// Any signed-in user may ask: the answer is false for everyone else (the definer never errors), so it names no admin.
export function registerAdminMe(app: App): void {
  defineRoute(app, {
    method: "get",
    path: "/api/v1/instance/admin",
    policy: "session",
    access: "user",
    handler: ({ inUserTx }) =>
      inUserTx(async (tx) => {
        const check = await tx.query<{ ok: boolean }>("SELECT app.instance_admin_check() AS ok");
        return { admin: check.rows[0]?.ok === true };
      }),
  });
}
