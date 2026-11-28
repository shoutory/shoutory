import { Trans } from "@lingui/react/macro";
import { type ReactNode, useState } from "react";
import { Link } from "react-router";
import { DeleteButton } from "./delete-dialog";
import { accepted, EffectButton, LINK, type Place, Refusal, useEffectCall } from "./post-effects";
import type { Resolution, Target } from "./post-facts";
import type { Names } from "./post-names";
import { ResolveButton } from "./resolve-dialog";

function CancelButton({ place, target }: { place: Place; target: Target }) {
  const call = useEffectCall(
    place,
    (post) => post(accepted, `/api/v1/workspaces/${place.ws}/operations/${target.operation?.id}/cancel`, {}),
    <Trans id="posts.result.cancelled">Cancelled. Nothing was posted.</Trans>,
  );
  return (
    <div className="flex flex-col items-start gap-2">
      <EffectButton call={call} testId="action-cancel">
        <Trans id="posts.action.cancel">Cancel</Trans>
      </EffectButton>
      <span className="text-sm text-text-muted">
        <Trans id="posts.action.cancel_until">You can cancel until sending starts.</Trans>
      </span>
      {call.failure ? <Refusal error={call.failure} place={place} /> : null}
    </div>
  );
}

function UnscheduleButton({ place, target }: { place: Place; target: Target }) {
  const call = useEffectCall(
    place,
    (post) =>
      post(accepted, `/api/v1/workspaces/${place.ws}/posts/${place.postId}/unschedule`, {
        variant_ids: [target.variant_id],
      }),
    <Trans id="posts.result.unscheduled">Unscheduled. It is a draft again.</Trans>,
  );
  return (
    <div className="flex flex-col items-start gap-3">
      <EffectButton call={call} testId="action-unschedule">
        <Trans id="posts.action.unschedule">Unschedule</Trans>
      </EffectButton>
      {call.failure ? <Refusal error={call.failure} place={place} /> : null}
    </div>
  );
}

const COMPOSER_LINKS: Readonly<Record<string, ReactNode>> = {
  edit: <Trans id="posts.action.edit">Edit</Trans>,
  schedule: <Trans id="posts.action.schedule">Schedule</Trans>,
  publish_now: <Trans id="posts.action.publish_now">Publish now</Trans>,
};

interface Props {
  place: Place;
  target: Target;
  named: Names;
  /** The parts of a thread, the first included: what a delete removes from the platform. */
  parts: number;
}

/** The buttons of one target, exactly the ones the server listed for it. */
export function TargetActions({ place, target, named, parts }: Props) {
  const [resolved, setResolved] = useState<Resolution | null>(null);
  const [deleting, setDeleting] = useState(false);
  const listed = (name: string) => target.actions.includes(name);
  return (
    <div data-testid="target-actions" className="flex flex-wrap items-start gap-3">
      {Object.keys(COMPOSER_LINKS).map((name) =>
        listed(name) ? (
          <Link
            key={name}
            to={`/w/${place.ws}/posts/${place.postId}/edit`}
            data-testid={`action-${name}`}
            className={LINK}
          >
            {COMPOSER_LINKS[name]}
          </Link>
        ) : null,
      )}
      {listed("unschedule") ? <UnscheduleButton place={place} target={target} /> : null}
      {listed("cancel") && target.operation !== null ? <CancelButton place={place} target={target} /> : null}
      {listed("resolve") || resolved !== null ? (
        <ResolveButton place={place} target={target} named={named} done={resolved} onDone={setResolved} />
      ) : null}
      {listed("delete") || deleting ? (
        <DeleteButton
          place={place}
          target={target}
          named={named}
          parts={parts}
          open={deleting}
          onOpenChange={setDeleting}
        />
      ) : null}
    </div>
  );
}
