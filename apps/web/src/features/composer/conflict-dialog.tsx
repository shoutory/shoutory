import { Trans } from "@lingui/react/macro";
import { draftSchema } from "@shoutory/core/content";
import { type ReactNode, useMemo, useState } from "react";
import { z } from "zod";
import { useLoad } from "../../account/use-load";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { DirText } from "../../ui/dir-text";
import { type Doc, fromDraft, textOf } from "./composer-data";

const versionSchema = z.object({ draft: draftSchema });

/** The words of a draft, channel by channel, each in its own direction. */
export function DraftView({
  title,
  doc,
  nameOf,
  testId,
}: {
  title: ReactNode;
  doc: Doc;
  nameOf: (id: string) => string;
  testId: string;
}) {
  return (
    <section data-testid={testId} className="flex flex-col gap-2">
      <h3 className="font-medium">{title}</h3>
      {doc.variants.length === 0 ? (
        <p dir="auto" className="text-start">
          {doc.base}
        </p>
      ) : (
        doc.variants.map((variant) => (
          <p key={variant.channelId} className="flex flex-col text-start">
            <span className="text-sm text-text-muted">
              <DirText>{nameOf(variant.channelId)}</DirText>
            </span>
            <span dir="auto" className="whitespace-pre-wrap wrap-anywhere">
              {textOf(doc, variant)}
            </span>
          </p>
        ))
      )}
    </section>
  );
}

/** Another save came first: both versions are shown and the person chooses one. */
export function ConflictDialog({
  base,
  postId,
  theirs,
  mine,
  nameOf,
  onKeepMine,
  onUseTheirs,
}: {
  base: string;
  postId: string;
  theirs: string;
  mine: Doc;
  nameOf: (id: string) => string;
  onKeepMine: () => Promise<unknown>;
  onUseTheirs: (doc: Doc) => void;
}) {
  const [busy, setBusy] = useState(false);
  const { state, reload } = useLoad(versionSchema, `${base}/posts/${postId}/versions/${theirs}`);
  const theirDoc = useMemo(() => (state.status === "done" ? fromDraft(state.data.draft) : null), [state]);
  return (
    <Dialog
      role="alertdialog"
      locked
      isOpen
      onOpenChange={() => undefined}
      title={<Trans id="composer.conflict.title">This draft changed somewhere else</Trans>}
    >
      <div data-testid="conflict-dialog" className="flex flex-col gap-4">
        <p>
          <Trans id="composer.conflict.body">
            Someone saved a newer version. Yours is still here. Choose the one to keep.
          </Trans>
        </p>
        <DraftView
          testId="conflict-mine-text"
          title={<Trans id="composer.conflict.yours">Your version</Trans>}
          doc={mine}
          nameOf={nameOf}
        />
        {theirDoc ? (
          <DraftView
            testId="conflict-theirs-text"
            title={<Trans id="composer.conflict.their_version">Their version</Trans>}
            doc={theirDoc}
            nameOf={nameOf}
          />
        ) : state.status === "failed" ? (
          <div data-testid="conflict-failed" role="alert" className="flex flex-col items-start gap-2">
            <p>
              <Trans id="composer.conflict.failed">We could not load their version. Nothing was changed.</Trans>
            </p>
            <Button data-testid="conflict-retry" onPress={reload}>
              <Trans id="posts.retry">Try again</Trans>
            </Button>
          </div>
        ) : (
          <p role="status">
            <Trans id="system.loading">Loading</Trans>
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <Button
            data-testid="conflict-mine"
            busy={busy}
            aria-disabled={busy || theirDoc === null}
            onPress={() => {
              if (theirDoc === null) return;
              setBusy(true);
              void onKeepMine().finally(() => setBusy(false));
            }}
          >
            <Trans id="composer.conflict.mine">Keep mine</Trans>
          </Button>
          <Button
            data-testid="conflict-theirs"
            aria-disabled={theirDoc === null || busy}
            onPress={() => theirDoc && onUseTheirs(theirDoc)}
          >
            <Trans id="composer.conflict.theirs">Use theirs</Trans>
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
