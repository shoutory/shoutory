import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef } from "react";
import { request } from "../../http/client";
import { formatNumber } from "../../i18n/i18n";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { DirText } from "../../ui/dir-text";
import { useFormatPrefs } from "../../ui/localized";
import { accepted, EffectButton, type Place, Refusal, useEffectCall } from "./post-effects";
import type { Target } from "./post-facts";
import type { Names } from "./post-names";
import { refusalWords } from "./post-words";

function Impact({ provider, parts }: { provider: string; parts: number }) {
  const { t } = useLingui();
  const shown = formatNumber(parts, useFormatPrefs());
  return (
    <>
      <Trans id="posts.delete.impact">
        Removes it from <DirText>{provider}</DirText>.
      </Trans>{" "}
      {parts > 1
        ? t({
            id: "posts.delete.parts",
            message: plural(parts, { one: "1 thread part.", other: `${shown} thread parts.` }),
          })
        : null}
      {parts > 1 ? " " : null}
      <Trans id="posts.delete.permanent">This cannot be undone on the platform.</Trans>
    </>
  );
}

function deleteWords(error: Parameters<typeof refusalWords>[0], provider: string) {
  const reason = error.details?.reason;
  if (reason === "delete_window_closed") {
    return {
      what: <Trans id="posts.delete.window.what">The time to delete this has passed</Trans>,
      meaning: (
        <Trans id="posts.delete.window.meaning">
          <DirText>{provider}</DirText> no longer lets us delete it from here. Delete it on{" "}
          <DirText>{provider}</DirText> itself. Nothing was changed.
        </Trans>
      ),
    };
  }
  if (reason === "not_published") {
    return {
      what: <Trans id="posts.delete.unpublished.what">This post was not published</Trans>,
      meaning: (
        <Trans id="posts.delete.unpublished.meaning">
          There is nothing on the platform to remove. Nothing was changed.
        </Trans>
      ),
    };
  }
  return refusalWords(error);
}

interface Props {
  place: Place;
  target: Target;
  named: Names;
  /** The parts of a thread, the first included. */
  parts: number;
  /** Kept by the row, so a refusal stays on screen after the server stops listing the action. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeleteButton({ place, target, named, parts, open, onOpenChange }: Props) {
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) trigger.current?.focus();
    wasOpen.current = open;
  }, [open]);
  const call = useEffectCall(
    place,
    (key) =>
      request(accepted, `/api/v1/workspaces/${place.ws}/posts/${place.postId}`, {
        method: "DELETE",
        body: { variant_ids: [target.variant_id] },
        headers: { "If-Match": `"${place.version}"` },
        idempotencyKey: key,
      }),
    undefined,
    () => onOpenChange(false),
  );
  return (
    <>
      <Button ref={trigger} data-testid="action-delete" onPress={() => onOpenChange(true)}>
        <Trans id="posts.delete.open">
          Delete from <DirText>{named.channel}</DirText>
        </Trans>
      </Button>
      <Dialog
        role="alertdialog"
        isOpen={open}
        locked={call.pending}
        onOpenChange={(next) => !call.pending && onOpenChange(next)}
        title={<Trans id="posts.delete.title">Delete this post from the channel?</Trans>}
      >
        <p data-testid="delete-impact">
          <Impact provider={named.provider} parts={parts} />
        </p>
        {call.failure ? (
          <div data-testid="delete-refusal">
            <Refusal error={call.failure} place={place} words={deleteWords(call.failure, named.provider)} />
          </div>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <EffectButton call={call} testId="delete-confirm">
            <Trans id="posts.delete.confirm">Delete</Trans>
          </EffectButton>
          <Button
            data-testid="delete-cancel"
            aria-disabled={call.pending}
            onPress={() => onOpenChange(false)}
          >
            <Trans id="posts.action.cancel">Cancel</Trans>
          </Button>
        </div>
      </Dialog>
    </>
  );
}
