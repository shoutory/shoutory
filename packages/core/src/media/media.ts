/** The image types the pipeline accepts: the type its bytes name, and the extension of the original it keeps. */
export const IMAGE_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
} as const;
export type ImageType = keyof typeof IMAGE_EXTENSIONS;
export const IMAGE_TYPES = Object.keys(IMAGE_EXTENSIONS) as readonly ImageType[];
export const isImageType = (mime: string): mime is ImageType => Object.hasOwn(IMAGE_EXTENSIONS, mime);

/** The video types the pipeline accepts: the type the bytes name (Matroska files other than webm are not among them). */
export const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;
export type VideoType = (typeof VIDEO_TYPES)[number];
export const isVideoType = (mime: string): mime is VideoType =>
  (VIDEO_TYPES as readonly string[]).includes(mime);

/** Why a medium is refused, by the pipeline and by `mediaFits` alike; stored as the asset's reject reason. */
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

/** What is known of one medium: its sniffed type, its size and pixels, its length (a video), and how many media its post holds. */
export interface MediaFacts {
  readonly mime: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  /** The length of a video in milliseconds; null (a row that has none) or absent is unknown. */
  readonly durationMs?: number | null;
  readonly count?: number;
}

/** The part of a provider manifest the rule reads: its capabilities and its named limits (`manifest.limits`). */
export interface MediaRules {
  readonly capabilities: readonly string[];
  readonly limits: Readonly<Record<string, { readonly value: number }>>;
}

export type MediaFit = { readonly ok: true } | { readonly ok: false; readonly reason: RejectReason };

type Limits = MediaRules["limits"];

/** The size, then the pixel rule of an image. */
function imageRefusal(
  facts: MediaFacts,
  { imageMaxBytes, imageMaxPixels }: Limits,
): RejectReason | undefined {
  if (imageMaxBytes && facts.bytes > imageMaxBytes.value) return "too_large";
  if (imageMaxPixels && facts.width * facts.height > imageMaxPixels.value) return "pixel_limit";
  return undefined;
}

/** The size, the length, then the pixel rule of a video; a video of unknown length does not pass a length limit. */
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

/**
 * The one rule set for what a provider takes: a manifest without the `image` (or `video`) capability refuses that kind,
 * a type outside the supported lists is refused, and each limit the manifest names (`imageMaxBytes`, `imageMaxPixels`,
 * `videoMaxBytes`, `videoMaxDurationMs`, `videoMaxPixels`, `mediaMaxCount`) is enforced on the kind it belongs to; a limit
 * it does not name is no limit.
 */
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
