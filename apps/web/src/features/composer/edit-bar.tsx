import { Trans, useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { z } from "zod";
import { Banner } from "../../ui/banner";
import { Button } from "../../ui/button";
import { ErrorPanel } from "../../ui/error-panel";
import { type Doc, type Issue, type Target, toDraft } from "./composer-data";
import { useEffectCall, useKeys } from "./publish-calls";
import { PublishRefusal } from "./publish-refusal";

const answerSchema = z.object({ id: z.string(), operation_ids: z.array(z.string()) });
const SHOW_RESULT_MS = 2000;

// Only the channels that list an edit are sent: the server refuses an edit that names any other channel of the post.
function editableDraft(doc: Doc, targets: readonly Target[]) {
  const editable = new Set(
    targets.filter((target) => target.actions.includes("edit")).map((target) => target.channel_id),
  );
  const draft = toDraft(doc);
  return { variants: draft.variants.filter((variant) => editable.has(variant.channel_id.toLowerCase())) };
}

export interface EditProps {
  workspace: string;
  postId: string;
  doc: Doc;
  loaded: Doc;
  targets: readonly Target[];
  issues: readonly Issue[];
  online: boolean;
  version: () => string | null;
  onDuplicate: () => void;
  onReload: () => void;
}

/** Sends a change to a post that is already live, as an edit of what each channel shows. */
export function EditBar(props: EditProps) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const call = useEffectCall();
  const post = useKeys();
  const [sent, setSent] = useState(false);
  const draft = editableDraft(props.doc, props.targets);
  const changed = JSON.stringify(draft) !== JSON.stringify(editableDraft(props.loaded, props.targets));
  const channels = new Set(draft.variants.map((variant) => variant.channel_id.toLowerCase()));
  const blocking = props.issues.filter((issue) => channels.has(issue.channelId)).length;
  const reason = !props.online
    ? t({ id: "auth.offline", message: "You are offline. This needs the server." })
    : blocking > 0
      ? t({ id: "composer.publish.fix", message: `Fix ${blocking} problems in the checks first.` })
      : !changed
        ? t({ id: "composer.edit.unchanged", message: "There are no changes to send." })
        : null;
  const open = useCallback(
    () => void navigate(`/w/${props.workspace}/posts/${props.postId}`),
    [navigate, props],
  );
  useEffect(() => {
    if (!sent) return;
    const timer = setTimeout(open, SHOW_RESULT_MS);
    return () => clearTimeout(timer);
  }, [sent, open]);
  const submit = () =>
    call.run("edit", async () => {
      const path = `/api/v1/workspaces/${props.workspace}/posts/${props.postId}/edit`;
      await post(answerSchema, path, { draft }, { "If-Match": `"${props.version()}"` });
      setSent(true);
    });
  return (
    <section aria-labelledby="composer-edit" className="flex flex-col gap-4">
      <h2 id="composer-edit" className="font-heading text-xl">
        <Trans id="composer.edit.heading">Change a post that is live</Trans>
      </h2>
      <p>
        <Trans id="composer.edit.explain">
          Your change is sent to each channel as an edit. Until the channel confirms it, the post there stays
          as it was.
        </Trans>
      </p>
      {sent ? (
        <Banner tone="info">
          <div data-testid="edit-sent" className="flex flex-wrap items-center gap-3">
            <Trans id="composer.publish.sent">Sent to the queue</Trans>
            <Button onPress={open}>
              <Trans id="composer.publish.open">Open post</Trans>
            </Button>
          </div>
        </Banner>
      ) : (
        <div>
          <Button
            data-testid="edit-submit"
            busy={call.busy === "edit"}
            aria-disabled={reason !== null}
            {...(reason === null ? {} : { reason })}
            onPress={() => void submit()}
          >
            <Trans id="composer.edit.submit">Send the change</Trans>
          </Button>
        </div>
      )}
      <Failure props={props} error={call.failure} />
    </section>
  );
}

function Failure({ props, error }: { props: EditProps; error: ReturnType<typeof useEffectCall>["failure"] }) {
  if (error === null) return null;
  if (error.code === "precondition_failed") {
    return (
      <div data-testid="edit-stale" className="flex flex-col items-start gap-3">
        <ErrorPanel
          error={error}
          what={<Trans id="composer.edit.stale.what">This post changed since you opened it</Trans>}
          meaning={
            <Trans id="composer.edit.stale.meaning">
              Nothing was sent. Reload to see the latest version.
            </Trans>
          }
        />
        <Button onPress={props.onReload}>
          <Trans id="composer.edit.reload">Reload</Trans>
        </Button>
      </div>
    );
  }
  return (
    <PublishRefusal
      testId="edit-failure"
      error={error}
      onEdit={props.onReload}
      onDuplicate={props.onDuplicate}
    />
  );
}
