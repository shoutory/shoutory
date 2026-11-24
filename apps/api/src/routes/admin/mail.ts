import type { AuthService } from "../../auth/auth.js";
import { checkMailDns } from "../../mail/dns-check.js";
import { enqueueMail } from "../../mail/enqueue.js";
import { type App, defineRoute } from "../define-route.js";
import { asAdmin, asAdminWrite } from "./admin.js";

export interface MailSettings {
  readonly from: string | undefined;
  readonly dkimSelector: string | undefined;
}

// The DNS check only reads records, so it needs no step-up. The test message is a write to the world: it takes a
// step-up and a verification-resend bucket token keyed by the caller's own address. The api holds no SMTP transport,
// so the worker sends it and the screen can say "queued" and nothing more.
export function registerMailChecks(app: App, auth: AuthService, settings: MailSettings): void {
  defineRoute(app, {
    method: "post",
    path: "/api/v1/admin/mail/check",
    policy: "session",
    access: "user",
    handler: async ({ inUserTx }) => {
      await asAdmin(inUserTx, async () => undefined);
      const { domain, records } = await checkMailDns(settings);
      return { domain: domain ?? null, records };
    },
  });
  defineRoute(app, {
    method: "post",
    path: "/api/v1/admin/mail/test",
    policy: "session",
    access: "user",
    handler: async ({ c, inUserTx }) => {
      await asAdminWrite(auth, c, inUserTx, async () => undefined);
      const { email } = c.get("session");
      await auth.throttle.spend("verification_resend", email);
      await inUserTx((tx) =>
        enqueueMail(
          tx,
          {
            workspaceId: null,
            recipient: email,
            template: "mail_test",
            locale: "en",
            vars: {},
            link: `${auth.publicOrigin}/admin/system`,
          },
          auth.mail,
        ),
      );
      return { queued: true };
    },
  });
}
