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

/** Why a medium is refused, by the pipeline and by `mediaFits` alike; stored as the asset's reject reason. */
export const REJECT_REASONS = [
  "type_mismatch",
  "unsupported_type",
  "pixel_limit",
  "corrupt",
  "timeout",
  // The image could not be processed after every retry: neither the image nor the clock is shown to be at fault.
  "processing_failed",
  "too_large",
  "too_many",
  "infected",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/** What is known of one medium: its sniffed type, its size and pixels, and how many media its post holds. */
export interface MediaFacts {
  readonly mime: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly count?: number;
}

/** The part of a provider manifest the rule reads: its capabilities and its named limits (`manifest.limits`). */
export interface MediaRules {
  readonly capabilities: readonly string[];
  readonly limits: Readonly<Record<string, { readonly value: number }>>;
}

export type MediaFit = { readonly ok: true } | { readonly ok: false; readonly reason: RejectReason };

/**
 * The one rule set for what a provider takes: a manifest without the `image` capability refuses images, a type outside
 * the supported list is refused, and each limit the manifest names (`imageMaxBytes`, `imageMaxPixels`, `mediaMaxCount`)
 * is enforced; a limit it does not name is no limit.
 */
export function mediaFits(facts: MediaFacts, rules: MediaRules): MediaFit {
  if (!rules.capabilities.includes("image") || !isImageType(facts.mime))
    return { ok: false, reason: "unsupported_type" };
  const { imageMaxBytes, imageMaxPixels, mediaMaxCount } = rules.limits;
  if (imageMaxBytes && facts.bytes > imageMaxBytes.value) return { ok: false, reason: "too_large" };
  if (imageMaxPixels && facts.width * facts.height > imageMaxPixels.value)
    return { ok: false, reason: "pixel_limit" };
  if (mediaMaxCount && (facts.count ?? 1) > mediaMaxCount.value) return { ok: false, reason: "too_many" };
  return { ok: true };
}
