import { Trans, useLingui } from "@lingui/react/macro";
import { draftSchema } from "@shoutory/core/content";
import { type ReactNode, useState } from "react";
import { Link, useNavigate } from "react-router";
import { z } from "zod";
import { useAction } from "../../auth/auth-frame";
import { type ApiError, request, uuidv7 } from "../../http/client";
import { Button } from "../../ui/button";
import { ErrorPanel } from "../../ui/error-panel";
import { useSignIn } from "../channels/channels-hub";
import type { Resolution, Target } from "./post-facts";
import type { Names } from "./post-names";
import { refusalWords } from "./post-words";
import { ResolveButton } from "./resolve-dialog";

const accepted = z.looseObject({});
const created = z.object({ id: z.string() });
const versionSchema = z.object({ draft: draftSchema });

export interface Place {
  readonly ws: string;
  readonly postId: string;
  /** Reads the post again after an effect, so the rows show what the server now says. */
  readonly refresh: () => void;
}

// One call that does something: a fresh key for each press, the post read again after it, and a refusal that says the
// state moved on read again too. A second press while it runs is ignored by `useAction`.
export function useEffectCall(place: Place, run: (key: string) => Promise<unknown>) {
  const signIn = useSignIn();
  return useAction(
    async () => {
      await run(uuidv7());
      place.refresh();
    },
    (error) => {
      if (error.state === "session_expired") signIn();
      else if (error.status === 409 || error.status === 412) place.refresh();
    },
  );
}

function useOffline() {
  const { t } = useLingui();
  return t({ id: "auth.offline", message: "You are offline. This needs the server." });
}

interface EffectProps {
  readonly call: ReturnType<typeof useEffectCall>;
  readonly testId: string;
  readonly children: ReactNode;
}

export function EffectButton({ call, testId, children }: EffectProps) {
  const offline = useOffline();
  return (
    <Button
      data-testid={testId}
      busy={call.pending}
      aria-disabled={call.pending || !call.online}
      {...(call.online ? {} : { reason: offline })}
      onPress={() => void call.run()}
    >
      {children}
    </Button>
  );
}

const LINK =
  "inline-flex min-h-10 pointer-coarse:min-h-11 items-center rounded-md border border-border-control px-5 text-md text-link underline";

/** A refusal, with the next steps the server listed (copy to a draft, edit) beside it. */
export function Refusal({
  error,
  place,
  words,
}: {
  error: ApiError;
  place: Place;
  words?: { what: ReactNode; meaning: ReactNode };
}) {
  const next = (error.lists?.actions ?? []).filter((one): one is string => typeof one === "string");
  const shown = words ?? refusalWords(error);
  return (
    <div data-testid="post-refusal" className="flex flex-col items-start gap-3">
      <ErrorPanel focusOnMount what={shown.what} meaning={shown.meaning} error={error} />
      {next.includes("duplicate") ? <DuplicateButton place={place} /> : null}
      {next.includes("edit") ? (
        <Link to={`/w/${place.ws}/posts/${place.postId}/edit`} className={LINK}>
          <Trans id="posts.action.edit">Edit</Trans>
        </Link>
      ) : null}
    </div>
  );
}

// The copy is made through the one create route from the current version's draft; the new draft opens in the composer.
export function DuplicateButton({ place, version }: { place: Place; version?: string }) {
  const navigate = useNavigate();
  const base = `/api/v1/workspaces/${place.ws}/posts`;
  const call = useAction(async () => {
    const id =
      version ??
      (await request(z.object({ current_version_id: z.string() }), `${base}/${place.postId}`))
        .current_version_id;
    const { draft } = await request(versionSchema, `${base}/${place.postId}/versions/${id}`);
    const copy = await request(created, base, { method: "POST", body: { draft }, idempotencyKey: uuidv7() });
    void navigate(`/w/${place.ws}/posts/${copy.id}/edit`);
  });
  return (
    <div className="flex flex-col items-start gap-3">
      <EffectButton call={call} testId="action-duplicate">
        <Trans id="posts.action.duplicate">Duplicate</Trans>
      </EffectButton>
      {call.failure ? <Refusal error={call.failure} place={place} /> : null}
    </div>
  );
}

function CancelButton({ place, target }: { place: Place; target: Target }) {
  const call = useEffectCall(place, (key) =>
    request(accepted, `/api/v1/workspaces/${place.ws}/operations/${target.operation?.id}/cancel`, {
      method: "POST",
      body: {},
      idempotencyKey: key,
    }),
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
  const call = useEffectCall(place, (key) =>
    request(accepted, `/api/v1/workspaces/${place.ws}/posts/${place.postId}/unschedule`, {
      method: "POST",
      body: { variant_ids: [target.variant_id] },
      idempotencyKey: key,
    }),
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

/** The buttons of one target, exactly the ones the server listed for it. */
export function TargetActions({ place, target, named }: { place: Place; target: Target; named: Names }) {
  const [resolved, setResolved] = useState<Resolution | null>(null);
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
    </div>
  );
}
