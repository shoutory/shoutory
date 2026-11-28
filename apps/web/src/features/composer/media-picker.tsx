import { Trans, useLingui } from "@lingui/react/macro";
import { useRef, useState } from "react";
import { FileTrigger } from "react-aria-components";
import { Button } from "../../ui/button";
import { DirText } from "../../ui/dir-text";
import { TextField } from "../../ui/text-field";
import { fitWords, hasThumb, kindOf, REASON_WORDS, reasonOf } from "../media/media";
import { type Doc, type MediaRef, mediaOf, withMedia, withVariant } from "./composer-data";
import { LibraryDialog } from "./library-dialog";
import { type Entry, type Facts, useFits, useMediaFacts, useStateWord, useUploader } from "./media-state";
import type { Channels } from "./variant-editor";

const ALT_MAX = 2000;

function Item({
  workspace,
  medium,
  facts,
  problems,
  readOnly,
  onRemove,
  onAlt,
}: {
  workspace: string;
  medium: MediaRef;
  facts: Facts;
  problems: string[];
  readOnly: boolean;
  onRemove: () => void;
  onAlt: (alt: string) => void;
}) {
  const { t, i18n } = useLingui();
  const stateWord = useStateWord();
  const row = facts.get(medium.media_id);
  const reason = row?.state === "rejected" ? reasonOf(row.reject_reason) : null;
  return (
    <li data-testid="media-item" className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-3">
        {row && hasThumb(row) ? (
          <img
            src={`/api/v1/workspaces/${workspace}/media/${row.id}/derivatives/thumb`}
            alt=""
            className="size-12 rounded-sm object-cover"
          />
        ) : null}
        <span className="flex min-w-0 flex-col">
          <DirText>{row?.file_name ?? medium.media_id}</DirText>
          <span data-testid="media-state" className="text-sm text-text-muted">
            {row ? stateWord(row.state) : null}
            {reason === null ? null : (
              <>
                {": "}
                {i18n._(REASON_WORDS[reason === "unknown" ? "corrupt" : reason])}
              </>
            )}
          </span>
        </span>
        {readOnly ? null : (
          <Button data-testid="media-remove" onPress={onRemove}>
            <Trans id="composer.media.remove">Remove</Trans>
          </Button>
        )}
      </div>
      {row && kindOf(row.mime) === "image" ? (
        <TextField
          testId="media-alt"
          label={t({ id: "composer.media.alt", message: "Alt text" })}
          value={medium.alt_text ?? ""}
          maxLength={ALT_MAX}
          isReadOnly={readOnly}
          onChange={onAlt}
        />
      ) : null}
      {problems.map((problem) => (
        <p key={problem} data-testid="media-fit" className="text-sm text-danger">
          {problem}
        </p>
      ))}
    </li>
  );
}

function Uploads({ entries, onRetry }: { entries: readonly Entry[]; onRetry: (key: number) => void }) {
  if (entries.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2" aria-live="polite">
      {entries.map((entry) => (
        <li
          key={entry.key}
          data-testid="upload-entry"
          data-status={entry.status}
          className="flex flex-col gap-1"
        >
          <DirText>{entry.name}</DirText>
          {entry.status === "uploading" ? (
            <span className="flex items-center gap-2">
              <progress value={entry.percent} max={100} aria-label={entry.name} />
              <Trans id="composer.upload.percent">{entry.percent}% sent</Trans>
            </span>
          ) : null}
          {entry.status === "done" && entry.duplicate ? (
            <span data-testid="upload-duplicate">
              <Trans id="composer.upload.duplicate">Already in your library</Trans>
            </span>
          ) : null}
          {entry.status === "failed" ? (
            <span className="flex flex-wrap items-center gap-3" role="alert">
              <Trans id="composer.upload.failed">This file was not sent. Nothing was added.</Trans>
              <Button data-testid="upload-retry" onPress={() => onRetry(entry.key)}>
                <Trans id="composer.upload.retry">Try again</Trans>
              </Button>
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

interface FilesArgs {
  workspace: string;
  doc: Doc;
  onUpdate: (change: (doc: Doc) => Doc) => void;
  tab: string;
  channels: Channels;
}

// The list of the tab, its edits (made on the latest document, so two uploads that end together both stay), where
// each file fits and what the channel's limit leaves.
function useFiles({ workspace, doc, onUpdate, tab, channels }: FilesArgs) {
  const { t, i18n } = useLingui();
  const variant = doc.variants.find((one) => one.channelId === tab);
  const listIn = (now: Doc): MediaRef[] => {
    const own = now.variants.find((one) => one.channelId === tab);
    return own ? mediaOf(now, own) : now.baseMedia;
  };
  const list = listIn(doc);
  const used = [...doc.baseMedia, ...doc.variants.flatMap((one) => mediaOf(doc, one))];
  const { facts, remember } = useMediaFacts(workspace, [...new Set(used.map((one) => one.media_id))]);
  const fits = useFits(
    workspace,
    list.map((one) => one.media_id),
  );
  const mimes = useRef(new Map<string, string>());
  const how = {
    kindOf: (id: string) => kindOf(facts.get(id)?.mime ?? mimes.current.get(id) ?? "image/png"),
    providerOf: channels.providerOf,
  };
  const edit = (change: (list: MediaRef[]) => MediaRef[]) =>
    onUpdate((now) => withMedia(now, tab, change(listIn(now)), how));
  const add = (id: string, mime?: string) => {
    if (mime) mimes.current.set(id, mime);
    edit((now) =>
      now.some((one) => one.media_id === id) ? now : [...now, { media_id: id, alt_text: null, crop: null }],
    );
  };
  const limit = variant ? channels.providerOf(variant.channelId)?.limits.media_max_count : undefined;
  const problemsOf = (id: string): string[] =>
    (variant ? [variant.channelId] : doc.variants.map((one) => one.channelId)).flatMap((channel) => {
      const fit = fits.get(id)?.get(channel);
      const name = channels.nameOf(channel);
      return fit && !fit.ok
        ? [t({ id: "composer.media.fit", message: `${name}: ${i18n._(fitWords(fit.reason))}` })]
        : [];
    });
  return {
    list,
    facts,
    remember,
    edit,
    add,
    limit,
    problemsOf,
    full: limit !== undefined && list.length >= limit,
  };
}

type Files = ReturnType<typeof useFiles>;

function Items({ workspace, files, readOnly }: { workspace: string; files: Files; readOnly: boolean }) {
  const { list, edit } = files;
  return (
    <ul className="flex flex-col gap-2">
      {list.map((medium) => (
        <Item
          key={medium.media_id}
          workspace={workspace}
          medium={medium}
          facts={files.facts}
          problems={files.problemsOf(medium.media_id)}
          readOnly={readOnly}
          onRemove={() => edit((now) => now.filter((one) => one.media_id !== medium.media_id))}
          onAlt={(alt) =>
            edit((now) =>
              now.map((one) =>
                one.media_id === medium.media_id ? { ...one, alt_text: alt === "" ? null : alt } : one,
              ),
            )
          }
        />
      ))}
    </ul>
  );
}

/** The files of the tab being edited: added from the library or uploaded, with where each one fits. */
export function MediaSection(props: FilesArgs & { readOnly: boolean }) {
  const { t } = useLingui();
  const { workspace, doc, onUpdate, readOnly } = props;
  const [browsing, setBrowsing] = useState(false);
  const variant = doc.variants.find((one) => one.channelId === props.tab);
  const files = useFiles(props);
  const uploader = useUploader(workspace, files.add);
  const full = files.full
    ? t({ id: "composer.media.full", message: `This channel takes up to ${files.limit} files.` })
    : undefined;
  return (
    <section aria-labelledby="composer-media" className="flex flex-col gap-3">
      <h3 id="composer-media" className="font-medium">
        <Trans id="composer.media.title">Files</Trans>
      </h3>
      {variant && variant.mediaOverride === null ? (
        <p className="text-sm text-text-muted">
          <Trans id="composer.media.same">Same files as the base</Trans>
        </p>
      ) : null}
      <Items workspace={workspace} files={files} readOnly={readOnly} />
      {readOnly ? null : (
        <div className="flex flex-wrap items-start gap-3">
          <Button
            data-testid="media-add-library"
            aria-disabled={full !== undefined}
            {...(full === undefined ? {} : { reason: full })}
            onPress={() => setBrowsing(true)}
          >
            <Trans id="composer.media.library">Add from your files</Trans>
          </Button>
          <FileTrigger
            allowsMultiple
            acceptedFileTypes={["image/*", "video/*"]}
            onSelect={(picked) => picked && void uploader.add([...picked])}
          >
            <Button data-testid="media-upload">
              <Trans id="composer.media.upload">Upload files</Trans>
            </Button>
          </FileTrigger>
          {variant && variant.mediaOverride !== null ? (
            <Button
              data-testid="media-reset"
              onPress={() => onUpdate((now) => withVariant(now, variant.channelId, { mediaOverride: null }))}
            >
              <Trans id="composer.media.reset">Use the base files</Trans>
            </Button>
          ) : null}
        </div>
      )}
      <Uploads entries={uploader.entries} onRetry={uploader.retry} />
      {browsing ? (
        <LibraryDialog
          workspace={workspace}
          chosen={files.list.map((one) => one.media_id)}
          onAdd={(row) => {
            files.remember(row);
            files.add(row.id, row.mime);
            setBrowsing(false);
          }}
          onClose={() => setBrowsing(false)}
        />
      ) : null}
    </section>
  );
}
