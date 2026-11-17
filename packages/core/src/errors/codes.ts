import { z } from "zod";

/** The closed set of error codes a response envelope may carry; a new code is added here first. */
export const errorCodeSchema = z.enum([
  "validation_failed",
  "payload_too_large",
  "unsupported_media_type",
  "not_found",
  "csrf_rejected",
  "service_unavailable",
  "internal_error",
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;
