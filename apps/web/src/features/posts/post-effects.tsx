import { Trans, useLingui } from "@lingui/react/macro";
import { draftSchema } from "@shoutory/core/content";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { z } from "zod";
import { useAction } from "../../auth/auth-frame";
import { type ApiError, request, uuidv7 } from "../../http/client";
import { Button } from "../../ui/button";
import { ErrorPanel } from "../../ui/error-panel";
import { useSignIn } from "../channels/channels-hub";
import { refusalWords } from "./post-words";

export const accepted = z.looseObject({});
const created = z.object({ id: z.string() });
const versionSchema = z.object({ draft: draftSchema });

export interface Place {
  readonly ws: string;
  readonly postId: string;
  /** The post's current version as of the last read: the version a delete or an edit is checked against. */
  readonly version: string;
  /** Reads the post again after an effect, so the rows show what the server now says. */
  readonly refresh: () => void;
}

// One call that does something: a fresh key for each press, the post read again after it, and a refusal that says the
// state moved on read again too. A second press while it runs is ignored by `useAction`.
export function useEffectCall(place: Place, run: (key: string) => Promise<unknown>, after?: () => void) {
  const signIn = useSignIn();
  return useAction(
    async () => {
      await run(uuidv7());
      place.refresh();
      after?.();
    },
    (error) => {
      if (error.state === "session_expired") signIn();
      else if (error.status === 409 || error.status === 412 || error.status === 428) place.refresh();
    },
  );
}

export function useOffline() {
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

export const LINK =
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
export function DuplicateButton({ place }: { place: Place }) {
  const navigate = useNavigate();
  const base = `/api/v1/workspaces/${place.ws}/posts`;
  const call = useAction(async () => {
    const { draft } = await request(versionSchema, `${base}/${place.postId}/versions/${place.version}`);
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
