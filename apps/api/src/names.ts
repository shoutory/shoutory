import { z } from "zod";

// The name rule every named thing shares: trimmed, 1 to `max` characters (the length of the JS string, which is what a
// form counts too), with no control, format (bidi marks included) or line and paragraph separator. U+0000 is among the
// controls, and PostgreSQL text cannot hold it.
const FORBIDDEN_IN_NAME = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export const nameOf = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !FORBIDDEN_IN_NAME.test(value), "no control, format or separator character");
