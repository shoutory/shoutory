import type { Context } from "hono";
import { z } from "zod";
import { nameOf } from "../names.js";
import type { AppEnv } from "./define-route.js";

// The input shapes and the list answer that the organization and workspace routes share.

/** The name of an organization or a workspace: the shared name rule, with the bound of the name columns. */
export const nameSchema = nameOf(128);

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

/**
 * The list envelope: `next_cursor` is the last row's cursor field (`id` unless the list pages by another key) of a
 * full page and null after a short one.
 */
export function pageAnswer(
  c: Context<AppEnv>,
  rows: Array<Record<string, unknown>>,
  limit: number,
  cursorField = "id",
  extraMeta: Record<string, unknown> = {},
): Response {
  const last = rows[rows.length - 1];
  const next = rows.length === limit && last ? String(last[cursorField]) : null;
  return c.json({ data: rows, meta: { ...extraMeta, next_cursor: next } }, 200);
}
