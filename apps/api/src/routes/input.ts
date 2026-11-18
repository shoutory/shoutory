import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "./define-route.js";

// The input shapes and the list answer that the organization and workspace routes share.

/** PostgreSQL text cannot hold U+0000 (it would answer 22021); the bounds are those of the name columns. */
export const nameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((name) => !name.includes("\0"), "no NUL character");

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** `?cursor=&limit=`: the cursor is the last row's id until it is signed (M4). */
export const pageQuery = z.strictObject({
  cursor: z
    .uuid()
    .transform((id) => id.toLowerCase())
    .optional(),
  // Digits only: `Number()` would take "0x10", "1e1" and "5.0" as 16, 10 and 5.
  limit: z
    .string()
    .regex(/^\d{1,3}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(MAX_LIMIT))
    .default(DEFAULT_LIMIT),
});

/** The list envelope: `next_cursor` is the last id of a full page and null after a short one. */
export function pageAnswer(c: Context<AppEnv>, rows: Array<{ id: string }>, limit: number): Response {
  const last = rows[rows.length - 1];
  return c.json({ data: rows, meta: { next_cursor: rows.length === limit && last ? last.id : null } }, 200);
}
