// Built from https://atproto.com/specs/lexicon app.bsky.richtext.facet (read 2026-11-27): a facet marks a byte range of
// the text, counted in UTF-8 bytes, with a link, a mention (the DID) or a tag. The text itself is never changed.

type Feature =
  | { readonly $type: "app.bsky.richtext.facet#link"; readonly uri: string }
  | { readonly $type: "app.bsky.richtext.facet#mention"; readonly did: string }
  | { readonly $type: "app.bsky.richtext.facet#tag"; readonly tag: string };

export interface Facet {
  readonly index: { readonly byteStart: number; readonly byteEnd: number };
  readonly features: readonly [Feature];
}

const LINK = /(?<=^|[\s(])https?:\/\/[^\s]+/gu;
const MENTION = /(?<=^|[\s(])@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)/giu;
const TAG = /(?<=^|\s)#([^\s#]*[^\d\s\p{P}][^\s#]*)/gu;
const SENTENCE_END = /[.,;:!?\]}'"]$/u;
const MAX_TAG_GRAPHEMES = 64;

const graphemeCount = (text: string) =>
  [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text)].length;

interface Found {
  readonly start: number;
  readonly end: number;
  readonly feature: () => Promise<Feature | undefined>;
}

const countOf = (text: string, mark: string) => [...text].filter((one) => one === mark).length;

// A tag or link stops before the punctuation that closes a sentence, and before a closing parenthesis that has no opening
// one inside the match, so `Foo_(bar)` keeps its own and `(see https://example.com/a)` does not take the outer one.
function trimmed(match: string): string {
  let text = match;
  while (SENTENCE_END.test(text) || (text.endsWith(")") && countOf(text, ")") > countOf(text, "("))) {
    text = text.slice(0, -1);
  }
  return text;
}

function linksIn(text: string): Found[] {
  return [...text.matchAll(LINK)].flatMap((match) => {
    const link = trimmed(match[0]);
    const valid = URL.canParse(link);
    return valid
      ? [
          {
            start: match.index,
            end: match.index + link.length,
            feature: async () => ({ $type: "app.bsky.richtext.facet#link" as const, uri: link }),
          },
        ]
      : [];
  });
}

function tagsIn(text: string): Found[] {
  return [...text.matchAll(TAG)].flatMap((match) => {
    const tag = trimmed(match[1] ?? "");
    const valid = tag !== "" && graphemeCount(tag) <= MAX_TAG_GRAPHEMES;
    return valid
      ? [
          {
            start: match.index,
            end: match.index + 1 + tag.length,
            feature: async () => ({ $type: "app.bsky.richtext.facet#tag" as const, tag }),
          },
        ]
      : [];
  });
}

function mentionsIn(text: string, resolve: (handle: string) => Promise<string | undefined>): Found[] {
  return [...text.matchAll(MENTION)].map((match) => {
    const handle = (match[1] ?? "").toLowerCase();
    return {
      start: match.index,
      end: match.index + 1 + (match[1] ?? "").length,
      feature: async () => {
        const did = await resolve(handle);
        return did === undefined ? undefined : { $type: "app.bsky.richtext.facet#mention" as const, did };
      },
    };
  });
}

const byteOffset = (text: string, index: number) => Buffer.byteLength(text.slice(0, index));

type Resolve = (handle: string) => Promise<string | undefined>;

const MAX_HANDLES = 10;

// Each distinct handle is looked up once, and at most ten per post; a mention beyond them stays plain text.
function sparingly(resolve: Resolve): Resolve {
  const asked = new Map<string, Promise<string | undefined>>();
  return (handle) => {
    const kept = asked.get(handle);
    if (kept !== undefined) return kept;
    if (asked.size >= MAX_HANDLES) return Promise.resolve(undefined);
    const answer = resolve(handle);
    asked.set(handle, answer);
    return answer;
  };
}

/** The facets of a text. `resolve` answers the DID of a mentioned handle, or nothing when no such account exists. */
export async function detectFacets(text: string, resolve: Resolve): Promise<Facet[]> {
  const found = [...linksIn(text), ...mentionsIn(text, sparingly(resolve)), ...tagsIn(text)].sort(
    (a, b) => a.start - b.start,
  );
  const facets: Facet[] = [];
  for (const one of found) {
    const feature = await one.feature();
    if (feature === undefined) continue;
    const index = { byteStart: byteOffset(text, one.start), byteEnd: byteOffset(text, one.end) };
    facets.push({ index, features: [feature] });
  }
  return facets;
}
