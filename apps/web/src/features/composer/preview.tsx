import { Trans } from "@lingui/react/macro";
import { DirText } from "../../ui/dir-text";
import { type Doc, textOf } from "./composer-data";

export function Preview({
  doc,
  nameOf,
  tab,
}: {
  doc: Doc;
  nameOf: (channelId: string) => string;
  tab: string;
}) {
  const shown = doc.variants.filter((variant) => tab === "all" || variant.channelId === tab);
  return (
    <aside aria-labelledby="composer-preview" className="flex flex-col gap-3">
      <h2 id="composer-preview" className="font-heading text-xl">
        <Trans id="composer.preview.title">Preview</Trans>
      </h2>
      {shown.length === 0 ? (
        <p>
          <Trans id="composer.preview.empty">Select a channel to see a preview.</Trans>
        </p>
      ) : (
        shown.map((variant) => (
          <article
            key={variant.channelId}
            data-testid="preview-card"
            className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4"
          >
            <p className="text-sm text-text-muted">
              <Trans id="composer.preview.label">Approximate preview</Trans>
            </p>
            <p className="font-medium">
              <DirText>{nameOf(variant.channelId)}</DirText>
            </p>
            {textOf(doc, variant)
              .split("\n")
              .map((line, at) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity
                <p key={at} dir="auto" className="text-start wrap-anywhere">
                  {line}
                </p>
              ))}
          </article>
        ))
      )}
    </aside>
  );
}
