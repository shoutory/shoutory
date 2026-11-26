import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { REJECT_REASONS, type RejectReason } from "@shoutory/core/media";
import { z } from "zod";

export const mediaSchema = z.object({
  id: z.uuid(),
  file_name: z.string(),
  mime: z.string(),
  state: z.string(),
  reject_reason: z.string().nullable(),
  tags: z.array(z.string()),
  derivatives: z.record(z.string(), z.string()),
});
export type Media = z.infer<typeof mediaSchema>;

export const detailSchema = mediaSchema.extend({
  byte_size: z.number(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  duration_ms: z.number().nullable(),
  created_at: z.iso.datetime({ offset: true }),
  post_count: z.number().int(),
});
export type Detail = z.infer<typeof detailSchema>;

export const fitSchema = z.object({
  data: z.array(z.object({ channel_id: z.uuid(), ok: z.boolean(), reason: z.string().optional() })),
  meta: z.object({ next_cursor: z.string().nullable() }),
});
export type Fit = z.infer<typeof fitSchema>["data"][number];

export const LISTED_STATES = [
  "pending_upload",
  "uploaded",
  "scanning",
  "processing",
  "ready",
  "rejected",
] as const;
type ListedState = (typeof LISTED_STATES)[number];

export const STATE_WORDS: Record<ListedState, MessageDescriptor> = {
  pending_upload: msg({ id: "media.state.pending_upload", message: "Waiting for upload" }),
  uploaded: msg({ id: "media.state.uploaded", message: "Uploaded" }),
  scanning: msg({ id: "media.state.scanning", message: "Checking" }),
  processing: msg({ id: "media.state.processing", message: "Processing" }),
  ready: msg({ id: "media.state.ready", message: "Ready" }),
  rejected: msg({ id: "media.state.rejected", message: "Rejected" }),
};
export const UNKNOWN_STATE = msg({ id: "media.state.unknown", message: "Unknown state" });

export const REASON_WORDS: Record<RejectReason, MessageDescriptor> = {
  type_mismatch: msg({ id: "media.reason.type_mismatch", message: "The content does not match the type." }),
  unsupported_type: msg({ id: "media.reason.unsupported_type", message: "This file type is not supported." }),
  pixel_limit: msg({ id: "media.reason.pixel_limit", message: "The image has more pixels than allowed." }),
  too_long: msg({ id: "media.reason.too_long", message: "The video is longer than allowed." }),
  corrupt: msg({ id: "media.reason.corrupt", message: "The file is damaged and cannot be read." }),
  timeout: msg({ id: "media.reason.timeout", message: "Processing the file took too long." }),
  processing_failed: msg({ id: "media.reason.processing_failed", message: "Processing the file failed." }),
  too_large: msg({ id: "media.reason.too_large", message: "The file is bigger than allowed." }),
  too_many: msg({ id: "media.reason.too_many", message: "There are more files than allowed." }),
  infected: msg({ id: "media.reason.infected", message: "The safety check found a threat in this file." }),
};
export const UNKNOWN_REASON = msg({ id: "media.reason.unknown", message: "This file cannot be used." });

const DOWN = msg({ id: "media.fit.provider_unavailable", message: "The network is not available now." });
const CANNOT = msg({ id: "media.fit.capability_missing", message: "This channel cannot take this type." });
const FIT_ONLY_WORDS: Record<string, MessageDescriptor> = {
  provider_unavailable: DOWN,
  capability_missing: CANNOT,
};
const FIT_UNKNOWN = msg({ id: "media.fit.unknown", message: "This channel cannot take this file." });

export const fitWords = (reason: string | undefined): MessageDescriptor => {
  const known = reasonOf(reason ?? null);
  if (known !== "unknown") return REASON_WORDS[known];
  return (reason !== undefined && FIT_ONLY_WORDS[reason]) || FIT_UNKNOWN;
};

const COPY_WORDS: Record<string, MessageDescriptor> = {
  thumb: msg({ id: "media.copy.thumb", message: "Thumbnail" }),
  stripped: msg({ id: "media.copy.stripped", message: "Copy without location data" }),
};
const OTHER_COPY = msg({ id: "media.copy.other", message: "Other copy" });
export const copyWords = (profile: string) => COPY_WORDS[profile] ?? OTHER_COPY;

const COPY_STATE_WORDS: Record<string, MessageDescriptor> = {
  pending: msg({ id: "media.copy_state.pending", message: "Being made" }),
  ready: msg({ id: "media.copy_state.ready", message: "Ready" }),
  failed: msg({ id: "media.copy_state.failed", message: "Could not be made" }),
};
export const copyStateWords = (state: string) => COPY_STATE_WORDS[state] ?? UNKNOWN_STATE;

export const stateOf = (state: string): ListedState | "unknown" =>
  LISTED_STATES.find((known) => known === state) ?? "unknown";

export const reasonOf = (reason: string | null): RejectReason | "unknown" =>
  REJECT_REASONS.find((known) => known === reason) ?? "unknown";

export const kindOf = (mime: string): "image" | "video" => (mime.startsWith("video/") ? "video" : "image");

/** A thumbnail is served only for a ready image whose thumbnail is ready; the stored type decides, never the name. */
export const hasThumb = (media: Media) =>
  media.state === "ready" && kindOf(media.mime) === "image" && media.derivatives.thumb === "ready";
