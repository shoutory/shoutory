export const IMAGE_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
} as const;
export type ImageType = keyof typeof IMAGE_EXTENSIONS;
export const IMAGE_TYPES = Object.keys(IMAGE_EXTENSIONS) as readonly ImageType[];
export const isImageType = (mime: string): mime is ImageType => Object.hasOwn(IMAGE_EXTENSIONS, mime);

// Matroska files other than webm are not accepted.
export const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;
export type VideoType = (typeof VIDEO_TYPES)[number];
export const isVideoType = (mime: string): mime is VideoType =>
  (VIDEO_TYPES as readonly string[]).includes(mime);

export const REJECT_REASONS = [
  "type_mismatch",
  "unsupported_type",
  "pixel_limit",
  "too_long",
  "corrupt",
  "timeout",
  // The image could not be processed after every retry: neither the image nor the clock is shown to be at fault.
  "processing_failed",
  "too_large",
  "too_many",
  "infected",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export interface MediaFacts {
  readonly mime: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly durationMs?: number | null;
  readonly count?: number;
}

export interface MediaRules {
  readonly capabilities: readonly string[];
  readonly limits: Readonly<Record<string, { readonly value: number }>>;
}

export type MediaFit = { readonly ok: true } | { readonly ok: false; readonly reason: RejectReason };

type Limits = MediaRules["limits"];

function imageRefusal(
  facts: MediaFacts,
  { imageMaxBytes, imageMaxPixels }: Limits,
): RejectReason | undefined {
  if (imageMaxBytes && facts.bytes > imageMaxBytes.value) return "too_large";
  if (imageMaxPixels && facts.width * facts.height > imageMaxPixels.value) return "pixel_limit";
  return undefined;
}

// A video of unknown length does not pass a length limit.
function videoRefusal(
  facts: MediaFacts,
  { videoMaxBytes, videoMaxDurationMs, videoMaxPixels }: Limits,
): RejectReason | undefined {
  if (videoMaxBytes && facts.bytes > videoMaxBytes.value) return "too_large";
  if (videoMaxDurationMs && (facts.durationMs ?? Number.POSITIVE_INFINITY) > videoMaxDurationMs.value)
    return "too_long";
  if (videoMaxPixels && facts.width * facts.height > videoMaxPixels.value) return "pixel_limit";
  return undefined;
}

// A limit the manifest does not name is no limit.
export function mediaFits(facts: MediaFacts, rules: MediaRules): MediaFit {
  const kind = isImageType(facts.mime) ? "image" : isVideoType(facts.mime) ? "video" : undefined;
  if (kind === undefined || !rules.capabilities.includes(kind))
    return { ok: false, reason: "unsupported_type" };
  const reason = kind === "image" ? imageRefusal(facts, rules.limits) : videoRefusal(facts, rules.limits);
  if (reason) return { ok: false, reason };
  const { mediaMaxCount } = rules.limits;
  if (mediaMaxCount && (facts.count ?? 1) > mediaMaxCount.value) return { ok: false, reason: "too_many" };
  return { ok: true };
}
