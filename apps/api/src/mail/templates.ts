import { z } from "zod";

// `marketing` mail has its own sender.
type MailClass = "transactional" | "marketing";

export interface MailTemplate {
  readonly class: MailClass;
  // A secret never goes in vars, and every schema is strict.
  readonly vars: z.ZodType;
  render(link: string, vars: unknown): { readonly subject: string; readonly text: string };
}

function template<S extends z.ZodType>(spec: {
  class: MailClass;
  vars: S;
  subject: (vars: z.infer<S>) => string;
  text: (copy: { link: string; vars: z.infer<S> }) => string;
}): MailTemplate {
  return {
    class: spec.class,
    vars: spec.vars,
    render(link, raw) {
      const vars = spec.vars.parse(raw);
      return { subject: spec.subject(vars), text: spec.text({ link, vars }) };
    },
  };
}

const IGNORE = "If you did not expect this message, you can ignore it.";

export const TEMPLATES = {
  verify_email: template({
    class: "transactional",
    vars: z.strictObject({}),
    subject: () => "Confirm your email address",
    text: ({ link }) =>
      `An account was created with this email address. Open this link to confirm it:\n\n${link}\n\nIf you did not create an account, do not open the link.\n`,
  }),
  reset_password: template({
    class: "transactional",
    vars: z.strictObject({}),
    subject: () => "Reset your password",
    text: ({ link }) => `Open this link to choose a new password:\n\n${link}\n\n${IGNORE}\n`,
  }),
  existing_account_notice: template({
    class: "transactional",
    vars: z.strictObject({}),
    subject: () => "You already have an account",
    text: ({ link }) =>
      `Someone tried to sign up with this address, but an account already exists. To sign in, open:\n\n${link}\n\n${IGNORE}\n`,
  }),
  signup_closed_notice: template({
    class: "transactional",
    vars: z.strictObject({}),
    subject: () => "Sign-up is closed",
    text: ({ link }) =>
      `Someone tried to sign up with this address, but sign-up is closed on this instance. If it was you, ask the person who runs it for an invitation. To sign in to an account you already have, open:\n\n${link}\n\n${IGNORE}\n`,
  }),
  invitation: template({
    class: "transactional",
    vars: z.strictObject({
      workspaceName: z.string().min(1).max(128),
      role: z.string().min(1).max(32),
    }),
    subject: ({ workspaceName }) => `You are invited to ${workspaceName}`,
    text: ({ link, vars }) =>
      `You are invited to join ${vars.workspaceName} as ${vars.role}. Open this link to accept:\n\n${link}\n\n${IGNORE}\n`,
  }),
  mail_test: template({
    class: "transactional",
    vars: z.strictObject({}),
    subject: () => "Test message from Shoutory",
    text: ({ link }) =>
      `This is the test message you asked for from the admin screen. If you can read it, outgoing mail works. The screen is here:\n\n${link}\n`,
  }),
} as const;

export type TemplateName = keyof typeof TEMPLATES;
export const TEMPLATE_NAMES = Object.keys(TEMPLATES) as [TemplateName, ...TemplateName[]];
