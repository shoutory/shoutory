import { useLingui } from "@lingui/react/macro";
import type { ApiError } from "../../http/client";
import { Button } from "../../ui/button";
import { ErrorPanel } from "../../ui/error-panel";

function useCopy() {
  const { t } = useLingui();
  return (reason: string): { what: string; meaning: string } => {
    switch (reason) {
      case "post_in_flight":
        return {
          what: t({ id: "composer.refused.in_flight.what", message: "This post is being sent right now" }),
          meaning: t({
            id: "composer.refused.in_flight.meaning",
            message: "Your change is kept here and can be applied when sending ends. Nothing was changed.",
          }),
        };
      case "use_edit":
        return {
          what: t({ id: "composer.refused.use_edit.what", message: "This post is already live" }),
          meaning: t({
            id: "composer.refused.use_edit.meaning",
            message: "Changing it here would not change what people see.",
          }),
        };
      case "variant_has_history":
        return {
          what: t({ id: "composer.refused.history.what", message: "A channel already has a posting record" }),
          meaning: t({
            id: "composer.refused.history.meaning",
            message: "Remove it from the post with Delete instead, so the record stays clear.",
          }),
        };
      case "post_archived":
        return {
          what: t({ id: "composer.refused.archived.what", message: "This post is archived" }),
          meaning: t({ id: "composer.refused.archived.meaning", message: "Restore it to make changes." }),
        };
      case "channel_not_connected":
        return {
          what: t({ id: "composer.refused.channel.what", message: "A channel needs to be reconnected" }),
          meaning: t({
            id: "composer.refused.channel.meaning",
            message: "Reconnect it or take it out of this post. Nothing was scheduled.",
          }),
        };
      case "media_unavailable":
        return {
          what: t({ id: "composer.refused.media.what", message: "A file cannot be used" }),
          meaning: t({
            id: "composer.refused.media.meaning",
            message: "Remove it or choose another. Nothing was scheduled.",
          }),
        };
      case "edit_window_closed":
        return {
          what: t({
            id: "composer.refused.window.what",
            message: "The time for editing this post has ended",
          }),
          meaning: t({
            id: "composer.refused.window.meaning",
            message: "The network no longer lets this post be edited. Make a copy instead.",
          }),
        };
      default:
        return {
          what: t({ id: "composer.refused.other.what", message: "We could not do that" }),
          meaning: t({ id: "composer.refused.other.meaning", message: "Nothing was changed." }),
        };
    }
  };
}

/** The refusal of a write to a post, with the next steps the server lists beside its reason. */
export function PublishRefusal({
  error,
  onEdit,
  onDuplicate,
  testId,
}: {
  error: ApiError;
  onEdit: () => void;
  onDuplicate: () => void;
  testId: string;
}) {
  const { t } = useLingui();
  const copy = useCopy()(error.details?.reason ?? "");
  const listed = (error.lists?.actions ?? []).filter((one): one is string => typeof one === "string");
  return (
    <div data-testid={testId} className="flex flex-col items-start gap-3">
      <ErrorPanel error={error} what={copy.what} meaning={copy.meaning} />
      <div className="flex flex-wrap items-center gap-3">
        {listed.includes("edit") ? (
          <Button onPress={onEdit}>{t({ id: "composer.refused.edit", message: "Edit this post" })}</Button>
        ) : null}
        {listed.includes("duplicate") ? (
          <Button onPress={onDuplicate}>
            {t({ id: "composer.refused.duplicate", message: "Duplicate to draft" })}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
