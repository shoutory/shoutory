import { useLingui } from "@lingui/react/macro";
import type { ApiError } from "../../http/client";
import { Button } from "../../ui/button";
import { ErrorPanel } from "../../ui/error-panel";
import { refusalWords } from "../posts/post-words";

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
  const words = refusalWords(error);
  const listed = (error.lists?.actions ?? []).filter((one): one is string => typeof one === "string");
  return (
    <div data-testid={testId} className="flex flex-col items-start gap-3">
      <ErrorPanel error={error} what={words.what} meaning={words.meaning} />
      <div className="flex flex-wrap items-center gap-3">
        {listed.includes("edit") ? (
          <Button onPress={onEdit}>{t({ id: "composer.refused.edit", message: "Edit this post" })}</Button>
        ) : null}
        {listed.includes("duplicate") ? (
          <Button data-testid="refusal-duplicate" onPress={onDuplicate}>
            {t({ id: "composer.refused.duplicate", message: "Duplicate to draft" })}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
