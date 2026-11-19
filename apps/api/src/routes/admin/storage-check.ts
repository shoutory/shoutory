import type { StorageDriver } from "@shoutory/core/storage";
import type { AuthService } from "../../auth/auth.js";
import { checkStorage } from "../../storage/check.js";
import { type App, defineRoute } from "../define-route.js";
import { asAdminWrite } from "./admin.js";

/**
 * The storage test of the instance admin screen. The probe writes and deletes an object, so it is a write: the admin
 * check comes first and the step-up second. It runs only after that transaction has ended (AGENTS 3.7), and it writes no
 * audit row because it changes no setting.
 */
export function registerStorageCheck(app: App, auth: AuthService, storage: StorageDriver): void {
  defineRoute(app, {
    method: "post",
    path: "/api/v1/admin/storage/check",
    policy: "session",
    access: "user",
    handler: async ({ c, inUserTx }) => {
      await asAdminWrite(auth, c, inUserTx, async () => undefined);
      return checkStorage(storage);
    },
  });
}
