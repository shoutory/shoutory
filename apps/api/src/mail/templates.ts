import { z } from "zod";

// The mail templates of M0. `vars` is what the template may carry besides the sealed link; a secret never goes
// in it, and every schema is strict so an extra field is refused.
export const TEMPLATES = {
  verify_email: { vars: z.strictObject({}) },
  reset_password: { vars: z.strictObject({}) },
  existing_account_notice: { vars: z.strictObject({}) },
} as const;

export type TemplateName = keyof typeof TEMPLATES;
export const TEMPLATE_NAMES = Object.keys(TEMPLATES) as [TemplateName, ...TemplateName[]];
