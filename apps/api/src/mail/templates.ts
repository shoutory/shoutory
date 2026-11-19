import { z } from "zod";

/** `transactional`: mail to a person who just acted (links, alerts). `marketing`: anything else; it has its own sender. */
type MailClass = "transactional" | "marketing";

export interface MailTemplate {
  readonly class: MailClass;
  /** What the template may carry besides the sealed link; a secret never goes in it, and every schema is strict. */
  readonly vars: z.ZodType;
  /** The plain-text mail of one row: the link opened from the sealed column and the variables the row stored. */
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

// The mail templates of M0, English only.
export const TEMPLATES = {
  verify_email: template({
    class: "transactional",
    vars: z.strictObject({}),
    subject: () => "Confirm your email address",
    text: ({ link }) => `Open this link to confirm your email address:\n\n${link}\n\n${IGNORE}\n`,
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
} as const;

export type TemplateName = keyof typeof TEMPLATES;
export const TEMPLATE_NAMES = Object.keys(TEMPLATES) as [TemplateName, ...TemplateName[]];
