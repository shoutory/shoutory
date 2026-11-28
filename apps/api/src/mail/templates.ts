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
  // A mail with no sealed link is sent as it is; its copy has no link to show.
  readonly sealedLink: boolean;
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
  sealedLink?: boolean;
  vars: S;
  copy: Record<MailLocale, Copy<z.infer<S>>>;
}): MailTemplate {
  return {
    class: spec.class,
    sealedLink: spec.sealedLink ?? true,
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

const noticeVars = z.strictObject({
  level: z.string().min(1).max(16),
  name: z.string().min(1).max(128).optional(),
  provider: z.string().min(1).max(128).optional(),
  days: z.number().int().min(1).max(365).optional(),
  reason: z.string().min(1).max(128).optional(),
});
type NoticeVars = z.infer<typeof noticeVars>;

const daysIn = (locale: MailLocale, count: number): string => {
  if (locale === "en") return count === 1 ? "1 day" : `${count} days`;
  if (count === 1) return "يوم واحد";
  return count <= 10 ? `${count} أيام` : `${count} يوماً`;
};
// The days come from the mail's own variable, else from its level (`7d`).
const daysOf = (locale: MailLocale, vars: NoticeVars): string =>
  daysIn(locale, vars.days ?? (Number.parseInt(vars.level, 10) || 1));
const channelOf = (locale: MailLocale, vars: NoticeVars): string =>
  vars.name === undefined ? (locale === "en" ? "a channel" : "قناة") : isolate(vars.name);
// The first reminder of an unclear post carries no prefix; each later step is a reminder.
const isReminder = (vars: NoticeVars): boolean => {
  const step = /^escalation_(\d+)$/.exec(vars.level)?.[1];
  return step !== undefined && Number(step) > 0;
};

// A notice is a few plain sentences with no link; the screen it points to is named in words.
function notice(spec: {
  en: { subject: (vars: NoticeVars) => string; text: (vars: NoticeVars) => string };
  ar: { subject: (vars: NoticeVars) => string; text: (vars: NoticeVars) => string };
}): MailTemplate {
  return template({
    class: "transactional",
    sealedLink: false,
    vars: noticeVars,
    copy: {
      en: { subject: spec.en.subject, text: ({ vars }) => `${spec.en.text(vars)}\n` },
      ar: { subject: spec.ar.subject, text: ({ vars }) => `${spec.ar.text(vars)}\n` },
    },
  });
}

const REMINDER: Record<MailLocale, string> = { en: "Reminder: ", ar: "تذكير: " };
const reminderOf = (locale: MailLocale, vars: NoticeVars): string =>
  isReminder(vars) ? REMINDER[locale] : "";

export const NOTICE_TEMPLATES = {
  token_expiry: notice({
    en: {
      subject: (v) => `Access to ${channelOf("en", v)} expires in ${daysOf("en", v)}`,
      text: (v) =>
        `The connection to ${channelOf("en", v)} expires in ${daysOf("en", v)}. Reconnect it from the Channels page before then, or posts to it will wait until you do.`,
    },
    ar: {
      subject: (v) => `ينتهي الاتصال بالقناة ${channelOf("ar", v)} خلال ${daysOf("ar", v)}`,
      text: (v) =>
        `ينتهي الاتصال بالقناة ${channelOf("ar", v)} خلال ${daysOf("ar", v)}. أعد ربطها من صفحة القنوات قبل ذلك، وإلا ستنتظر المنشورات الموجّهة إليها حتى تفعل.`,
    },
  }),
  reconnect_deadline: notice({
    en: {
      subject: (v) => `Reconnect ${channelOf("en", v)} within ${daysOf("en", v)}`,
      text: (v) =>
        `${channelOf("en", v)} is not connected. Its waiting posts are kept for ${daysOf("en", v)} more. Reconnect it from the Channels page to send them; after that they go back to your drafts.`,
    },
    ar: {
      subject: (v) => `أعد ربط القناة ${channelOf("ar", v)} خلال ${daysOf("ar", v)}`,
      text: (v) =>
        `القناة ${channelOf("ar", v)} غير متصلة. تُحفظ منشوراتها المنتظرة ${daysOf("ar", v)} أخرى. أعد ربطها من صفحة القنوات لإرسالها، وبعد ذلك تعود إلى مسوداتك.`,
    },
  }),
  needs_human: notice({
    en: {
      subject: (v) => `${reminderOf("en", v)}A post to ${channelOf("en", v)} needs your decision`,
      text: (v) =>
        `A post to ${channelOf("en", v)} could not be settled on its own. Open the post to see what happened and choose what comes next.`,
    },
    ar: {
      subject: (v) => `${reminderOf("ar", v)}منشور على القناة ${channelOf("ar", v)} ينتظر قرارك`,
      text: (v) =>
        `تعذّر حسم منشور على القناة ${channelOf("ar", v)} تلقائياً. افتح المنشور لترى ما حدث واختر الخطوة التالية.`,
    },
  }),
  unverified: notice({
    en: {
      subject: (v) => `${reminderOf("en", v)}A post to ${channelOf("en", v)} is not confirmed`,
      text: (v) =>
        `We still could not confirm that a post to ${channelOf("en", v)} went out. Check the channel, then open the post and tell us what you found.`,
    },
    ar: {
      subject: (v) => `${reminderOf("ar", v)}منشور على القناة ${channelOf("ar", v)} لم يتأكد نشره`,
      text: (v) =>
        `ما زلنا لم نتمكن من التأكد من نشر منشور على القناة ${channelOf("ar", v)}. تحقّق من القناة ثم افتح المنشور وأخبرنا بما وجدته.`,
    },
  }),
  held_media: notice({
    en: {
      subject: (v) => `A post to ${channelOf("en", v)} is waiting for its media`,
      text: (v) =>
        `A post to ${channelOf("en", v)} is due, but its media is not ready. It goes out as soon as the media is ready. Open the post to check the media.`,
    },
    ar: {
      subject: (v) => `منشور على القناة ${channelOf("ar", v)} ينتظر وسائطه`,
      text: (v) =>
        `حان موعد منشور على القناة ${channelOf("ar", v)} لكن وسائطه ليست جاهزة. سيُنشر حالما تجهز الوسائط. افتح المنشور لتتحقق منها.`,
    },
  }),
  drafts_day_30: notice({
    en: {
      subject: (v) => `Posts held for ${channelOf("en", v)} are back in your drafts`,
      text: (v) =>
        `${channelOf("en", v)} was not reconnected within 30 days, so the posts waiting for it are back in your drafts. Nothing was deleted. Choose another channel, or reconnect it and schedule them again.`,
    },
    ar: {
      subject: (v) => `عادت المنشورات المنتظرة للقناة ${channelOf("ar", v)} إلى مسوداتك`,
      text: (v) =>
        `لم تُعد ربط القناة ${channelOf("ar", v)} خلال 30 يوماً، فعادت المنشورات المنتظرة لها إلى مسوداتك. لم يُحذف شيء. اختر قناة أخرى، أو أعد ربطها وجدول المنشورات من جديد.`,
    },
  }),
} as const;

const LINK_TEMPLATES = {
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

export const TEMPLATES = { ...LINK_TEMPLATES, ...NOTICE_TEMPLATES } as const;

// The templates that carry a sealed link; the notices have none and are queued by their own definer.
export type TemplateName = keyof typeof LINK_TEMPLATES;
export const TEMPLATE_NAMES = Object.keys(LINK_TEMPLATES) as [TemplateName, ...TemplateName[]];
