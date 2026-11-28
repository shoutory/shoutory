import { z } from "zod";

export const idsSchema = z.object({ variant_ids: z.array(z.string()) });
export const scheduledSchema = idsSchema.extend({ due_at: z.string(), due_tz: z.string() });
