import { type Draft, draftSchema, supportsVariant, type Variant } from "@shoutory/core/content";
import { countingRuleSchema, countText } from "@shoutory/core/counting";
import { z } from "zod";

export type PostType = Variant["post_type"];
type Medium = Variant["media"][number];

export const providerSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  capabilities: z.array(z.string()),
  counting: countingRuleSchema,
  limits: z.object({
    text_length: z.number().optional(),
    text_bytes: z.number().optional(),
    media_max_count: z.number().optional(),
  }),
  follow_up_roles: z.array(z.string()),
});
export type Provider = z.infer<typeof providerSchema>;

const detailVariant = z.object({
  channel_id: z.string(),
  locale: z.string().nullable(),
  post_type: z.string(),
  text: z.string(),
  parts: z.array(z.object({ kind: z.string(), text: z.string() })),
  settings: z.record(z.string(), z.unknown()),
  media: z.array(
    z.object({
      position: z.number(),
      media_id: z.string(),
      alt_text: z.string().nullable(),
      crop: z.unknown(),
    }),
  ),
});

const target = z.object({
  variant_id: z.string(),
  channel_id: z.string(),
  schedule_state: z.string(),
  published_at: z.string().nullable(),
  due_at: z.string().nullable(),
  due_tz: z.string().nullable(),
  hold_reason: z.string().nullable(),
  operation: z.object({ id: z.string() }).nullable().default(null),
  actions: z.array(z.string()),
});

export type Target = z.infer<typeof target>;

export const profileSchema = z.object({ default_tz: z.string() });

/** A wall-clock time as `YYYY-MM-DDTHH:mm` in a zone, the form the schedule takes; read, never computed with. */
export function wallClock(zone: string, at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const part = (type: string) => parts.find((one) => one.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

export const detailSchema = z.object({
  id: z.string(),
  current_version_id: z.string(),
  variants: z.array(detailVariant),
  targets: z.array(target),
});
export type Detail = z.infer<typeof detailSchema>;

/** One channel's variant as the person edits it: the text and files may follow the base or be their own. */
export interface VariantDoc {
  channelId: string;
  locale: string | null;
  postType: PostType;
  override: string | null;
  threadParts: string[];
  firstComment: string;
  mediaOverride: Medium[] | null;
  settings: Variant["settings"];
}

export interface Doc {
  base: string;
  baseMedia: Medium[];
  variants: VariantDoc[];
}

export const EMPTY_DOC: Doc = { base: "", baseMedia: [], variants: [] };

export const textOf = (doc: Doc, variant: VariantDoc): string => variant.override ?? doc.base;
export const mediaOf = (doc: Doc, variant: VariantDoc): Medium[] => variant.mediaOverride ?? doc.baseMedia;

export function toDraft(doc: Doc): Draft {
  return {
    variants: doc.variants.map((variant) => ({
      channel_id: variant.channelId,
      locale: variant.locale,
      post_type: variant.postType,
      text: textOf(doc, variant),
      parts: [
        ...variant.threadParts.map((text) => ({ kind: "thread_reply" as const, text })),
        ...(variant.firstComment === ""
          ? []
          : [{ kind: "first_comment" as const, text: variant.firstComment }]),
      ],
      settings: variant.settings,
      media: mediaOf(doc, variant),
    })),
  };
}

// The server keeps one text per variant, so the base is the text most variants share and the others are overrides.
function mostCommon<T>(items: readonly T[], key: (item: T) => string): T | undefined {
  const counts = new Map<string, { item: T; n: number }>();
  for (const item of items) {
    const entry = counts.get(key(item));
    if (entry) entry.n += 1;
    else counts.set(key(item), { item, n: 1 });
  }
  let best: { item: T; n: number } | undefined;
  for (const entry of counts.values()) if (!best || entry.n > best.n) best = entry;
  return best?.item;
}

export function fromDraft(draft: Draft): Doc {
  const base = mostCommon(draft.variants, (variant) => variant.text)?.text ?? "";
  const mediaKey = (media: Medium[]) => JSON.stringify(media);
  const baseMedia = mostCommon(draft.variants, (variant) => mediaKey(variant.media))?.media ?? [];
  return {
    base,
    baseMedia,
    variants: draft.variants.map((variant) => ({
      channelId: variant.channel_id.toLowerCase(),
      locale: variant.locale,
      postType: variant.post_type,
      override: variant.text === base ? null : variant.text,
      threadParts: variant.parts.filter((part) => part.kind === "thread_reply").map((part) => part.text),
      firstComment: variant.parts.findLast((part) => part.kind === "first_comment")?.text ?? "",
      mediaOverride: mediaKey(variant.media) === mediaKey(baseMedia) ? null : variant.media,
      settings: variant.settings,
    })),
  };
}

export function docOfDetail(detail: Detail): Doc | undefined {
  const parsed = draftSchema.safeParse({
    variants: detail.variants.map(({ media, ...variant }) => ({
      ...variant,
      media: media
        .toSorted((a, b) => a.position - b.position)
        .map(({ position: _position, ...medium }) => medium),
    })),
  });
  return parsed.success ? fromDraft(parsed.data) : undefined;
}

function newVariant(channelId: string): VariantDoc {
  return {
    channelId,
    locale: null,
    postType: "text",
    override: null,
    threadParts: [],
    firstComment: "",
    mediaOverride: null,
    settings: {},
  };
}

/** The channels picked, in the order they were picked; a channel kept keeps its edits. */
export function withChannels(doc: Doc, channelIds: readonly string[]): Doc {
  const kept = doc.variants.filter((variant) => channelIds.includes(variant.channelId));
  const added = channelIds
    .filter((id) => !kept.some((variant) => variant.channelId === id))
    .map((id) => newVariant(id));
  return { ...doc, variants: [...kept, ...added] };
}

export type MediaRef = Medium;
type MediaKind = "image" | "video";

// The type that follows from the files, shown in the type field; a provider that does not take it keeps what was chosen.
function typeFor(media: readonly Medium[], kindOf: (mediaId: string) => MediaKind): PostType {
  if (media.length === 0) return "text";
  if (media.some((one) => kindOf(one.media_id) === "video")) return "video";
  return media.length > 1 ? "multi_image" : "image";
}

function retyped(
  variant: VariantDoc,
  media: readonly Medium[],
  kindOf: (id: string) => MediaKind,
  provider: Provider | undefined,
) {
  const next = typeFor(media, kindOf);
  return provider && postTypesOf(provider).includes(next) ? { ...variant, postType: next } : variant;
}

/** The files of one channel's variant (or, on the first tab, of the base) replaced by `media`. */
export function withMedia(
  doc: Doc,
  tab: string,
  media: Medium[],
  how: { kindOf: (mediaId: string) => MediaKind; providerOf: (channelId: string) => Provider | undefined },
): Doc {
  if (tab === "all") {
    return {
      ...doc,
      baseMedia: media,
      variants: doc.variants.map((variant) =>
        variant.mediaOverride === null
          ? retyped(variant, media, how.kindOf, how.providerOf(variant.channelId))
          : variant,
      ),
    };
  }
  return {
    ...doc,
    variants: doc.variants.map((variant) =>
      variant.channelId === tab
        ? { ...retyped(variant, media, how.kindOf, how.providerOf(tab)), mediaOverride: media }
        : variant,
    ),
  };
}

export function withVariant(doc: Doc, channelId: string, change: Partial<VariantDoc>): Doc {
  return {
    ...doc,
    variants: doc.variants.map((variant) =>
      variant.channelId === channelId ? { ...variant, ...change } : variant,
    ),
  };
}

const BASIC_TYPES: readonly PostType[] = ["text", "image", "multi_image", "video"];

/** The post types the channel's provider takes, asked of the rule the server uses. */
export function postTypesOf(provider: Provider): PostType[] {
  const rules = { capabilities: provider.capabilities, followUpRoles: [] };
  return BASIC_TYPES.filter((type) =>
    supportsVariant(
      { channel_id: "", locale: null, post_type: type, text: "", parts: [], settings: {}, media: [] },
      rules,
    ),
  );
}

export interface Counter {
  kind: "length" | "bytes";
  used: number;
  limit: number;
}

const encoder = new TextEncoder();

export function countersOf(provider: Provider, text: string): Counter[] {
  const { text_length: length, text_bytes: bytes } = provider.limits;
  return [
    ...(length === undefined
      ? []
      : [{ kind: "length" as const, used: countText(provider.counting, text), limit: length }]),
    ...(bytes === undefined
      ? []
      : [{ kind: "bytes" as const, used: encoder.encode(text).length, limit: bytes }]),
  ];
}

export const overBy = (counters: readonly Counter[]): number =>
  Math.max(0, ...counters.map((counter) => counter.used - counter.limit));

export interface Issue {
  channelId: string;
  key: string;
  reason: string;
  over?: number;
}

function variantIssues(doc: Doc, variant: VariantDoc, sent: Variant, provider: Provider): Issue[] {
  const issues: Issue[] = [];
  const add = (key: string, reason: string, over?: number) =>
    issues.push({ channelId: variant.channelId, key, reason, ...(over === undefined ? {} : { over }) });
  const rules = { capabilities: provider.capabilities, followUpRoles: provider.follow_up_roles };
  if (!supportsVariant(sent, rules)) add("post_type", "unsupported");
  const textOver = overBy(countersOf(provider, sent.text));
  if (textOver > 0) add("text", "too_long", textOver);
  sent.parts.forEach((part, at) => {
    const over = overBy(countersOf(provider, part.text));
    if (over > 0) add(`parts.${at}`, "too_long", over);
  });
  if (sent.text.trim() === "" && sent.media.length === 0) add("text", "empty");
  const most = provider.limits.media_max_count;
  if (most !== undefined && mediaOf(doc, variant).length > most) add("media", "too_many");
  return issues;
}

/** What blocks scheduling, by the rules the server applies at schedule time. */
export function issuesOf(doc: Doc, providerOf: (channelId: string) => Provider | undefined): Issue[] {
  const sent = toDraft(doc).variants;
  return doc.variants.flatMap((variant, at) => {
    const provider = providerOf(variant.channelId);
    const one = sent[at];
    return provider && one ? variantIssues(doc, variant, one, provider) : [];
  });
}
