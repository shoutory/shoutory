import { z } from "zod";

// Format characters (bidi marks included) are refused as well; U+0000 is a control, and PostgreSQL text cannot hold it.
const FORBIDDEN_IN_NAME = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export const nameOf = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !FORBIDDEN_IN_NAME.test(value), "no control, format or separator character");
