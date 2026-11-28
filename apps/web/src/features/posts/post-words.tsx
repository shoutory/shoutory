import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { DirText } from "../../ui/dir-text";
import { LocalizedNumber } from "../../ui/localized";
import type { Headline, HeadlineKey, WordKey } from "./post-facts";

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
