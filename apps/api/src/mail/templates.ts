import { parseAccept } from "hono/utils/accept";
import { z } from "zod";

// `marketing` mail has its own sender.
type MailClass = "transactional" | "marketing";

export const MAIL_LOCALES = ["en", "ar"] as const;
export type MailLocale = (typeof MAIL_LOCALES)[number];
const isMailLocale = (value: string): value is MailLocale =>
  (MAIL_LOCALES as readonly string[]).includes(value);

// A row queued before the language set was closed may hold another value: it is sent in English.
export const mailLocale = (stored: string): MailLocale => (isMailLocale(stored) ? stored : "en");

// The mail follows the language of the request that causes it: the highest-weighted one the copy exists in.
export function requestLocale(headers: Headers | undefined): MailLocale {
  for (const { type, q } of parseAccept(headers?.get("accept-language") ?? "")) {
    const primary = type.split("-")[0]?.toLowerCase() ?? "";
    if (q > 0 && isMailLocale(primary)) return primary;
  }
  return "en";
}

export interface MailTemplate {
  readonly class: MailClass;
  // A secret never goes in vars, and every schema is strict.
  readonly vars: z.ZodType;
  render(
    locale: MailLocale,
    link: string,
    vars: unknown,
  ): { readonly subject: string; readonly text: string };
}

interface Copy<V> {
  subject: (vars: V) => string;
  text: (copy: { link: string; vars: V }) => string;
}

function template<S extends z.ZodType>(spec: {
  class: MailClass;
  vars: S;
  copy: Record<MailLocale, Copy<z.infer<S>>>;
}): MailTemplate {
  return {
    class: spec.class,
    vars: spec.vars,
    render(locale, link, raw) {
      const vars = spec.vars.parse(raw);
      const copy = spec.copy[locale];
      return { subject: copy.subject(vars), text: copy.text({ link, vars }) };
    },
  };
}

// A user-chosen name may be written right to left inside a sentence of the other direction; isolating it
// keeps it from reordering the words around it.
// A direction mark inside the value could end the isolation early, so the value keeps none.
const isolate = (value: string) =>
  `${String.fromCodePoint(0x2068)}${value.replaceAll(/\p{Bidi_Control}/gu, "")}${String.fromCodePoint(0x2069)}`;

const ROLE_LABELS: Record<MailLocale, Record<string, string>> = {
  en: { owner: "Owner", admin: "Admin", editor: "Editor", approver: "Approver", viewer: "Viewer" },
  ar: { owner: "مالك", admin: "مدير", editor: "محرّر", approver: "معتمِد", viewer: "مشاهد" },
};
// A custom role has no translation: its key is shown as written.
const roleLabel = (locale: MailLocale, key: string) =>
  isolate((Object.hasOwn(ROLE_LABELS[locale], key) ? ROLE_LABELS[locale][key] : undefined) ?? key);

const IGNORE = "If you did not expect this message, you can ignore it.";
const IGNORE_AR = "إن لم تكن تتوقع هذه الرسالة فيمكنك تجاهلها.";
const NO_VARS = z.strictObject({});
const invitationVars = z.strictObject({
  workspaceName: z.string().min(1).max(128),
  role: z.string().min(1).max(32),
});

export const TEMPLATES = {
  verify_email: template({
    class: "transactional",
    vars: NO_VARS,
    copy: {
      en: {
        subject: () => "Confirm your email address",
        text: ({ link }) =>
          `An account was created with this email address. Open this link to confirm it:\n\n${link}\n\nIf you did not create an account, do not open the link.\n`,
      },
      ar: {
        subject: () => "أكّد عنوان بريدك الإلكتروني",
        text: ({ link }) =>
          `أُنشئ حساب بهذا العنوان. افتح هذا الرابط لتأكيده:\n\n${link}\n\nإن لم تنشئ حساباً فلا تفتح الرابط.\n`,
      },
    },
  }),
  reset_password: template({
    class: "transactional",
    vars: NO_VARS,
    copy: {
      en: {
        subject: () => "Reset your password",
        text: ({ link }) => `Open this link to choose a new password:\n\n${link}\n\n${IGNORE}\n`,
      },
      ar: {
        subject: () => "إعادة تعيين كلمة المرور",
        text: ({ link }) => `افتح هذا الرابط لاختيار كلمة مرور جديدة:\n\n${link}\n\n${IGNORE_AR}\n`,
      },
    },
  }),
  existing_account_notice: template({
    class: "transactional",
    vars: NO_VARS,
    copy: {
      en: {
        subject: () => "You already have an account",
        text: ({ link }) =>
          `Someone tried to sign up with this address, but an account already exists. To sign in, open:\n\n${link}\n\n${IGNORE}\n`,
      },
      ar: {
        subject: () => "لديك حساب بالفعل",
        text: ({ link }) =>
          `حاول أحدهم التسجيل بهذا العنوان، لكن لهذا العنوان حساباً بالفعل. لتسجيل الدخول افتح:\n\n${link}\n\n${IGNORE_AR}\n`,
      },
    },
  }),
  signup_closed_notice: template({
    class: "transactional",
    vars: NO_VARS,
    copy: {
      en: {
        subject: () => "Sign-up is closed",
        text: ({ link }) =>
          `Someone tried to sign up with this address, but sign-up is closed on this instance. If it was you, ask the person who runs it for an invitation. To sign in to an account you already have, open:\n\n${link}\n\n${IGNORE}\n`,
      },
      ar: {
        subject: () => "التسجيل مغلق",
        text: ({ link }) =>
          `حاول أحدهم التسجيل بهذا العنوان، لكن التسجيل مغلق في هذه النسخة. إن كنت أنت فاطلب دعوة ممن يديرها. لتسجيل الدخول إلى حساب لديك بالفعل افتح:\n\n${link}\n\n${IGNORE_AR}\n`,
      },
    },
  }),
  invitation: template({
    class: "transactional",
    vars: invitationVars,
    copy: {
      en: {
        subject: ({ workspaceName }) => `You are invited to ${isolate(workspaceName)}`,
        text: ({ link, vars }) =>
          `You are invited to join ${isolate(vars.workspaceName)} as ${roleLabel("en", vars.role)}. Open this link to accept:\n\n${link}\n\n${IGNORE}\n`,
      },
      ar: {
        subject: ({ workspaceName }) => `دعوة للانضمام إلى ${isolate(workspaceName)}`,
        text: ({ link, vars }) =>
          `دُعيت للانضمام إلى ${isolate(vars.workspaceName)} بدور ${roleLabel("ar", vars.role)}. افتح هذا الرابط لقبول الدعوة:\n\n${link}\n\n${IGNORE_AR}\n`,
      },
    },
  }),
  mail_test: template({
    class: "transactional",
    vars: NO_VARS,
    copy: {
      en: {
        subject: () => "Test message from Shoutory",
        text: ({ link }) =>
          `This is the test message you asked for from the admin screen. If you can read it, outgoing mail works. The screen is here:\n\n${link}\n`,
      },
      ar: {
        subject: () => "رسالة تجريبية من Shoutory",
        text: ({ link }) =>
          `هذه الرسالة التجريبية التي طلبتها من شاشة الإدارة. إن كنت تقرؤها فالبريد الصادر يعمل. الشاشة هنا:\n\n${link}\n`,
      },
    },
  }),
} as const;

export type TemplateName = keyof typeof TEMPLATES;
export const TEMPLATE_NAMES = Object.keys(TEMPLATES) as [TemplateName, ...TemplateName[]];
