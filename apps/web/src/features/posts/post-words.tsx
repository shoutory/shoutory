import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import type { ApiError } from "../../http/client";
import { formatNumber } from "../../i18n/i18n";
import { DirText } from "../../ui/dir-text";
import { LocalizedDateTime, LocalizedNumber, useFormatPrefs } from "../../ui/localized";
import { type EvidenceLine, type Headline, type HeadlineKey, safeLink, type WordKey } from "./post-facts";

const PAUSE_REASONS = [
  "quota",
  "entitlement",
  "provider_cooldown",
  "capability_withdrawn",
  "api_sunset",
  "channel_disabled",
];

/** The reason of a pause in words; a code the page has no word for gives no reason, never the code. */
export function usePauseReason(code: string | null | undefined, provider: string): ReactNode {
  const { t } = useLingui();
  if (code === null || code === undefined || !PAUSE_REASONS.includes(code)) return null;
  const words: Record<string, string> = {
    quota: t({ id: "posts.pause.quota", message: "quota reached" }),
    entitlement: t({ id: "posts.pause.entitlement", message: "plan limit" }),
    provider_cooldown: t({ id: "posts.pause.cooldown", message: `${provider} cooldown` }),
    capability_withdrawn: t({ id: "posts.pause.withdrawn", message: `this type was removed by ${provider}` }),
    api_sunset: t({ id: "posts.pause.sunset", message: "the API version expired" }),
    channel_disabled: t({ id: "posts.pause.disabled", message: "the channel is turned off" }),
  };
  return words[code];
}

export interface WordContext {
  readonly provider: string;
  readonly channel: string;
  readonly pauseReason?: ReactNode;
}

type LabelProps = { word: WordKey } & WordContext;

/** The label of one target: the status words of the spec, one per ledger state, outcome and presence. */
export function TargetLabel(props: LabelProps) {
  return (
    waitingLabel(props) ??
    checkLabel(props) ??
    endLabel(props) ?? <Trans id="posts.target.unknown">Status not available</Trans>
  );
}

function waitingLabel({ word, provider, pauseReason }: LabelProps): ReactNode {
  const platform = <DirText>{provider}</DirText>;
  switch (word) {
    case "draft":
      return <Trans id="posts.target.draft">Draft</Trans>;
    case "pending":
      return <Trans id="posts.target.pending">Waiting for its time</Trans>;
    case "claimed":
      return <Trans id="posts.target.claimed">Getting ready</Trans>;
    case "processing":
      return <Trans id="posts.target.processing">{platform} is preparing the media</Trans>;
    case "dispatching":
      return <Trans id="posts.target.dispatching">Sending</Trans>;
    case "provider_accepted":
      return <Trans id="posts.target.accepted">Accepted by {platform}, finishing</Trans>;
    case "retry_wait":
      return <Trans id="posts.target.retry_wait">Will retry</Trans>;
    case "paused":
      return pauseReason ? (
        <Trans id="posts.target.paused_reason">Paused: {pauseReason}</Trans>
      ) : (
        <Trans id="posts.target.paused">Paused</Trans>
      );
    default:
      return null;
  }
}

function checkLabel({ word, provider, channel }: LabelProps): ReactNode {
  const platform = <DirText>{provider}</DirText>;
  const place = <DirText>{channel}</DirText>;
  switch (word) {
    case "blocked_reconnect":
      return <Trans id="posts.target.held">Held: reconnect {place}</Trans>;
    case "unknown_external_state":
      return <Trans id="posts.target.checking">Checking whether it was posted</Trans>;
    case "reconciling":
      return <Trans id="posts.target.reconciling">Checking {platform} now</Trans>;
    case "needs_human":
      return <Trans id="posts.target.needs_check">Needs your check</Trans>;
    case "needs_human_past_due":
      return <Trans id="posts.target.past_due">Nothing was posted; its time passed</Trans>;
    case "unverified":
      return <Trans id="posts.target.unverified">Could not be confirmed</Trans>;
    default:
      return null;
  }
}

function endLabel({ word, provider }: LabelProps): ReactNode {
  const platform = <DirText>{provider}</DirText>;
  switch (word) {
    case "published":
      return <Trans id="posts.target.published">Published</Trans>;
    case "published_draft_delivered":
      return <Trans id="posts.target.draft_delivered">Delivered as a draft on {platform}</Trans>;
    case "published_scheduled":
      return <Trans id="posts.target.scheduled_there">Scheduled on {platform}, not live yet</Trans>;
    case "failed":
      return <Trans id="posts.target.failed">Failed</Trans>;
    case "cancelled":
      return <Trans id="posts.target.cancelled">Cancelled</Trans>;
    case "missed":
      return <Trans id="posts.target.missed">Missed</Trans>;
    case "superseded_after_unknown_outcome":
      return <Trans id="posts.target.replaced">Replaced after an unclear result</Trans>;
    case "edit_pending":
      return <Trans id="posts.target.edit_pending">Applying your edit</Trans>;
    case "edit_failed":
      return <Trans id="posts.target.edit_failed">Edit not applied</Trans>;
    case "removal_pending":
      return <Trans id="posts.target.removal_pending">Removing from {platform}</Trans>;
    case "removed_at_provider":
      return <Trans id="posts.target.removed">Removed from {platform}</Trans>;
    case "removal_unknown":
      return <Trans id="posts.target.removal_unknown">We could not confirm it was removed</Trans>;
    case "removal_reported":
      return <Trans id="posts.target.removal_reported">You confirmed it was removed</Trans>;
    default:
      return null;
  }
}

/** The headline of a post: Published only when every counted target is a live post. */
export function HeadlineWord({ headline }: { headline: Headline }) {
  const words: Record<HeadlineKey, ReactNode> = {
    needs_attention: <Trans id="posts.headline.needs_attention">Needs attention</Trans>,
    publishing: <Trans id="posts.headline.publishing">Publishing</Trans>,
    scheduled: <Trans id="posts.headline.scheduled">Scheduled</Trans>,
    published: <Trans id="posts.headline.published">Published</Trans>,
    published_not_live: (
      <Trans id="posts.headline.not_live">
        Published, <LocalizedNumber value={headline.k} /> not live
      </Trans>
    ),
    partially_published: <Trans id="posts.headline.partly">Partly published</Trans>,
    failed: <Trans id="posts.headline.failed">Failed</Trans>,
    missed: <Trans id="posts.headline.missed">Missed</Trans>,
    removing: <Trans id="posts.headline.removing">Removing</Trans>,
    removed: <Trans id="posts.headline.removed">Removed</Trans>,
    draft: <Trans id="posts.headline.draft">Draft</Trans>,
    in_review: <Trans id="posts.headline.in_review">In review</Trans>,
    changes_requested: <Trans id="posts.headline.changes_requested">Changes requested</Trans>,
    approved: <Trans id="posts.headline.approved">Approved</Trans>,
    archived: <Trans id="posts.headline.archived">Archived</Trans>,
    unknown: <Trans id="posts.headline.unknown">Status not available</Trans>,
  };
  return words[headline.key];
}

/** "{n} of {m} published", with the not-live count when some are not live. */
export function Summary({ headline }: { headline: Headline }) {
  const n = <LocalizedNumber value={headline.n} />;
  const m = <LocalizedNumber value={headline.m} />;
  if (headline.k > 0) {
    return (
      <Trans id="posts.summary_not_live">
        {n} of {m} published, <LocalizedNumber value={headline.k} /> not live
      </Trans>
    );
  }
  return (
    <Trans id="posts.summary">
      {n} of {m} published
    </Trans>
  );
}

/** The sentence under the headline; the count line is `Summary`. */
export function HeadlineMeaning({ headline }: { headline: Headline }) {
  const { t } = useLingui();
  const prefs = useFormatPrefs();
  const need = formatNumber(headline.x, prefs);
  switch (headline.key) {
    case "needs_attention":
      return t({
        id: "posts.meaning.need_you",
        message: plural(headline.x, {
          one: "1 needs you.",
          other: `${need} need you.`,
        }),
      });
    case "scheduled":
      return (
        <Trans id="posts.meaning.waiting">
          <LocalizedNumber value={headline.waiting} /> waiting
        </Trans>
      );
    case "published":
      return <Trans id="posts.meaning.live">Live on every channel</Trans>;
    case "partially_published":
      return (
        <Trans id="posts.meaning.did_not_go">
          <LocalizedNumber value={headline.f} /> did not go out
        </Trans>
      );
    default:
      return <HeadlineNote headline={headline} />;
  }
}

function HeadlineNote({ headline }: { headline: Headline }) {
  switch (headline.key) {
    case "publishing":
      return <Trans id="posts.meaning.publishing">Being sent now</Trans>;
    case "failed":
      return <Trans id="posts.meaning.failed">Nothing was posted</Trans>;
    case "missed":
      return <Trans id="posts.meaning.headline_missed">Its time passed and we never send late</Trans>;
    case "removing":
      return <Trans id="posts.meaning.removing">Being removed from the channel</Trans>;
    case "removed":
      return <Trans id="posts.meaning.removed">Removed from every channel</Trans>;
    case "draft":
      return <Trans id="posts.meaning.draft">Not scheduled yet</Trans>;
    default:
      return null;
  }
}

export interface MeaningContext extends WordContext {
  readonly dueAt: Date | null;
  readonly zone: string;
  readonly deadline: Date | null;
  readonly partIndex: number;
  readonly effect: string | null;
}
type MeaningProps = { word: WordKey } & MeaningContext;

/** The one line under a target's word. A fact the answer does not carry is left out, never invented. */
export function TargetMeaning(props: MeaningProps) {
  return progressMeaning(props) ?? attentionMeaning(props) ?? endMeaning(props);
}

function progressMeaning({ word, provider, dueAt, zone }: MeaningProps): ReactNode {
  const platform = <DirText>{provider}</DirText>;
  switch (word) {
    case "draft":
      return <Trans id="posts.meaning.draft">Not scheduled yet</Trans>;
    case "pending":
      return dueAt === null ? null : (
        <Trans id="posts.meaning.pending">
          Goes out <LocalizedDateTime value={dueAt} timeZone={zone} />
        </Trans>
      );
    case "claimed":
      return <Trans id="posts.meaning.claimed">Preparing to send</Trans>;
    case "processing":
      return <Trans id="posts.meaning.processing">Not posted yet; this usually takes a few minutes</Trans>;
    case "dispatching":
      return <Trans id="posts.meaning.dispatching">Being sent to {platform}</Trans>;
    case "provider_accepted":
      return (
        <Trans id="posts.meaning.accepted">
          {platform} is finishing it; a post may still appear or fail; we are confirming
        </Trans>
      );
    case "retry_wait":
      return <Trans id="posts.meaning.retry_wait">Nothing was posted yet.</Trans>;
    case "paused":
      return <Trans id="posts.meaning.paused">We will continue when the cause is gone</Trans>;
    default:
      return null;
  }
}

function attentionMeaning({ word, provider, channel, deadline, zone }: MeaningProps): ReactNode {
  switch (word) {
    case "blocked_reconnect":
      return deadline === null ? (
        <Trans id="posts.meaning.held_no_date">
          Reconnect the channel; after the deadline this becomes a draft
        </Trans>
      ) : (
        <Trans id="posts.meaning.held">
          Reconnect by <LocalizedDateTime value={deadline} timeZone={zone} />; after that this becomes a draft
        </Trans>
      );
    case "unknown_external_state":
      return (
        <Trans id="posts.meaning.checking">
          We are checking. To avoid a duplicate we have not posted again.
        </Trans>
      );
    case "reconciling":
      return <Trans id="posts.meaning.reconciling">We are reading the channel to confirm</Trans>;
    case "needs_human":
      return (
        <Trans id="posts.meaning.needs_check">
          We could not confirm this. To avoid a duplicate we have not posted again
        </Trans>
      );
    case "needs_human_past_due":
      return (
        <Trans id="posts.meaning.past_due">
          <DirText>{channel}</DirText> was disconnected when this was due. Posting now would be late
        </Trans>
      );
    case "unverified":
      return (
        <Trans id="posts.meaning.unverified">
          We stopped checking; it still blocks new posts to this channel
        </Trans>
      );
    case "removal_unknown":
      return (
        <Trans id="posts.meaning.removal_unknown">
          Open <DirText>{provider}</DirText> to check, then confirm what you found.
        </Trans>
      );
    default:
      return null;
  }
}

function endMeaning({ word, provider, channel, partIndex, effect }: MeaningProps): ReactNode {
  const platform = <DirText>{provider}</DirText>;
  const place = <DirText>{channel}</DirText>;
  switch (word) {
    case "published_draft_delivered":
      return <Trans id="posts.meaning.draft_delivered">Finish posting there</Trans>;
    case "published_scheduled":
      return (
        <Trans id="posts.meaning.scheduled_there">
          Nothing is wrong; {platform} will publish it at that time and we will confirm
        </Trans>
      );
    case "failed":
      return <FailedMeaning place={place} partIndex={partIndex} effect={effect} />;
    case "cancelled":
      return <Trans id="posts.meaning.cancelled">It was cancelled before anything was sent</Trans>;
    case "missed":
      return <Trans id="posts.meaning.missed">Its time passed; we never send late</Trans>;
    case "superseded_after_unknown_outcome":
      return (
        <Trans id="posts.meaning.replaced">A new post was made; we are still watching for the old one</Trans>
      );
    default:
      return editMeaning(word, platform);
  }
}

function editMeaning(word: WordKey, platform: ReactNode): ReactNode {
  switch (word) {
    case "edit_pending":
      return (
        <Trans id="posts.meaning.edit_pending">
          The change is being sent to {platform}. The live post may still show the old text.
        </Trans>
      );
    case "edit_failed":
      return (
        <Trans id="posts.meaning.edit_failed">
          The change was not applied. The post may still show the earlier text.
        </Trans>
      );
    case "removal_pending":
      return (
        <Trans id="posts.meaning.removal_pending">Asked {platform} to remove it. We are confirming.</Trans>
      );
    case "removed_at_provider":
      return <Trans id="posts.meaning.removed_there">It is no longer on {platform}.</Trans>;
    case "removal_reported":
      return <Trans id="posts.meaning.removal_reported">You told us it was removed.</Trans>;
    default:
      return null;
  }
}

function FailedMeaning({
  place,
  partIndex,
  effect,
}: {
  place: ReactNode;
  partIndex: number;
  effect: string | null;
}) {
  if (partIndex > 0) {
    return (
      <Trans id="posts.meaning.failed_part">
        Parts 1 to <LocalizedNumber value={partIndex} /> are live; part{" "}
        <LocalizedNumber value={partIndex + 1} /> was not posted
      </Trans>
    );
  }
  if (effect === "none") {
    return <Trans id="posts.meaning.failed_none">Nothing was posted to {place}</Trans>;
  }
  return <Trans id="posts.meaning.failed_other">We could not post to {place}</Trans>;
}

export function EvidenceWords({ line, provider }: { line: EvidenceLine; provider: string }) {
  if (line === "you") return <Trans id="posts.evidence.you">Confirmed by you</Trans>;
  if (line === "read_back") {
    return <Trans id="posts.evidence.read_back">Confirmed by reading the post back</Trans>;
  }
  return (
    <Trans id="posts.evidence.answer">
      Confirmed by <DirText>{provider}</DirText>'s answer
    </Trans>
  );
}

/** What a refused write says: what happened and what it means for the post, never the server's own words. */
export function refusalWords(error: ApiError): { what: ReactNode; meaning: ReactNode } {
  if (error.details?.reason === "post_in_flight") {
    return {
      what: <Trans id="posts.refused.in_flight.what">This channel is being posted right now</Trans>,
      meaning: (
        <Trans id="posts.refused.in_flight.meaning">
          Wait until it finishes, then try again. Nothing was changed.
        </Trans>
      ),
    };
  }
  if (error.state === "forbidden") {
    return {
      what: <Trans id="posts.refused.forbidden.what">You cannot do this</Trans>,
      meaning: (
        <Trans id="posts.refused.forbidden.meaning">
          Only the author of the post, an admin or the owner can. Nothing was changed.
        </Trans>
      ),
    };
  }
  if (error.status === 409 || error.status === 412 || error.status === 428) {
    return {
      what: <Trans id="posts.refused.moved.what">This post changed while you were looking</Trans>,
      meaning: (
        <Trans id="posts.refused.moved.meaning">
          The page now shows the latest state. Check it, then try again. Nothing was changed.
        </Trans>
      ),
    };
  }
  return {
    what: <Trans id="posts.refused.failed.what">We could not do that</Trans>,
    meaning: <Trans id="posts.refused.failed.meaning">Nothing was changed. Try again.</Trans>,
  };
}

/** The stored address of a post: a link only for http and https, text for anything else. */
export function PostLink({ address, provider }: { address: string; provider: string }) {
  const href = safeLink(address);
  if (href === null) {
    return (
      <span data-testid="target-link">
        <DirText>{address}</DirText>
      </span>
    );
  }
  return (
    <a
      data-testid="target-link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="min-h-6 pointer-coarse:min-h-11 text-link underline"
    >
      <Trans id="posts.link.open">
        Open the post on <DirText>{provider}</DirText> (opens in a new tab)
      </Trans>
    </a>
  );
}

export const HeldMediaWords = () => (
  <Trans id="posts.hold.media">
    Waiting for its media. A file is still being prepared or was not accepted; check the files of this post.
  </Trans>
);
