import type { AuthService } from "../../auth/auth.js";
import { checkMailDns } from "../../mail/dns-check.js";
import { enqueueMail } from "../../mail/enqueue.js";
import { type App, defineRoute } from "../define-route.js";
import { asAdmin, asAdminWrite } from "./admin.js";

/** The sender the mail check reads the domain and the DKIM selector from (the process's own mail settings). */
export interface MailSettings {
  readonly from: string | undefined;
  readonly dkimSelector: string | undefined;
}

/**
 * The mail checks of the Z-06 screen. The DNS check only reads records of the sending domain, so it needs the admin and
 * no recent step-up. The test message is a write to the world: it needs the admin, a recent step-up and a token of the
 * verification-resend bucket keyed by the caller's own address, and it only queues one message to that address. The
 * api holds no SMTP transport, so the worker sends it and the screen can say "queued" and nothing more.
 */
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
