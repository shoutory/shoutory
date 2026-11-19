import { type App, defineRoute } from "../define-route.js";

// Whether the signed-in user is an instance admin, for the shell to show the Admin entry. Any signed-in user may ask:
// the answer is false for everyone else (the definer never errors), so it names no admin and no route.
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
