import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button as PlainButton } from "react-aria-components";
import { z } from "zod";
import { type ApiError, request } from "../../http/client";
import { formatNumber } from "../../i18n/i18n";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { DirText } from "../../ui/dir-text";
import { ErrorPanel } from "../../ui/error-panel";
import { useFormatPrefs } from "../../ui/localized";
import { TextField } from "../../ui/text-field";
import { toasts } from "../../ui/toast";
import { useSignIn } from "../channels/channels-hub";
import { asApiError, type Detail, detailSchema } from "./media";

type Words = { what: ReactNode; meaning: ReactNode };

export interface EditHandlers {
  onSaved: (medium: Detail) => void;
  onGone: () => void;
  readAgain: () => void;
}

interface FormProps {
  medium: Detail;
  base: string;
  close: () => void;
  handlers: EditHandlers;
}

// The server's bounds, checked first so a long name or tag is named on its field.
const NAME_MAX = 255;
const TAG_MAX = 64;
const TAGS_MAX = 32;
const CONTROL = /\p{Cc}/u;

// Closing a dialog returns focus to the button that opened it.
function useOpener() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) ref.current?.focus();
    wasOpen.current = open;
  }, [open]);
  return { open, setOpen, ref };
}

interface Send<A, T> {
  send: (arg: A) => Promise<T>;
  done: (answer: T) => void;
  // Answers true for a refusal the caller handles itself, which then shows no error panel.
  settle: (error: ApiError) => boolean;
  // Said in a toast when the answer fails after the dialog was closed.
  lost: string;
}

function useSend<A, T>({ send, done, settle, lost }: Send<A, T>) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const expired = useSignIn();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = (arg: A) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    send(arg).then(
      (answer) => {
        setBusy(false);
        done(answer);
      },
      (error: unknown) => {
        const answer = asApiError(error);
        setBusy(false);
        if (answer.state === "session_expired") expired();
        else if (settle(answer)) return;
        else if (mounted.current) setFailure(answer);
        else toasts.show({ kind: "error", title: lost });
      },
    );
  };
  return { busy, failure, run };
}

function saveCopy(error: ApiError): Words {
  if (error.code === "validation_failed")
    return {
      what: <Trans id="media.edit.refused.what">The name or a tag was not accepted</Trans>,
      meaning: <Trans id="media.edit.refused.meaning">Check them and save again. Nothing was changed.</Trans>,
    };
  if (error.state === "forbidden")
    return {
      what: <Trans id="media.edit.forbidden.what">You cannot change this file</Trans>,
      meaning: (
        <Trans id="media.edit.forbidden.meaning">Your role may have changed. Nothing was changed.</Trans>
      ),
    };
  return {
    what: <Trans id="media.edit.failed.what">We could not save your changes</Trans>,
    meaning: <Trans id="media.failed.meaning">Nothing was changed. Try again.</Trans>,
  };
}

function deleteCopy(error: ApiError): Words {
  const reason = error.status === 409 ? error.details?.reason : undefined;
  if (reason === "in_use")
    return {
      what: <Trans id="media.delete.in_use.what">This file is in use</Trans>,
      meaning: (
        <Trans id="media.delete.in_use.meaning">
          A post, a pending send or the workspace picture still uses this file.
        </Trans>
      ),
    };
  if (reason === "not_deletable")
    return {
      what: <Trans id="media.delete.not_deletable.what">This file cannot be deleted now</Trans>,
      meaning: <Trans id="media.delete.not_deletable.meaning">Its state changed. Nothing was deleted.</Trans>,
    };
  if (error.state === "forbidden")
    return {
      what: <Trans id="media.delete.forbidden.what">You cannot delete this file</Trans>,
      meaning: (
        <Trans id="media.delete.forbidden.meaning">Your role may have changed. Nothing was deleted.</Trans>
      ),
    };
  return {
    what: <Trans id="media.delete.failed.what">We could not delete this file</Trans>,
    meaning: <Trans id="media.delete.failed.meaning">Nothing was deleted. Try again.</Trans>,
  };
}

function useTags(initial: string[]) {
  const { t } = useLingui();
  const [tags, setTags] = useState(initial);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string>();
  // The list with the typed tag added, or undefined when that tag is refused; Save sends a tag not yet added too.
  const add = (): string[] | undefined => {
    const tag = draft.trim();
    if (tag.length > TAG_MAX || CONTROL.test(tag)) {
      setProblem(t({ id: "media.edit.tag_invalid", message: "Use at most 64 characters, on one line." }));
      return undefined;
    }
    if (tags.length >= TAGS_MAX && !tags.includes(tag)) {
      setProblem(t({ id: "media.edit.tags_full", message: "A file can have at most 32 tags." }));
      return undefined;
    }
    const next = tag !== "" && !tags.includes(tag) ? [...tags, tag] : tags;
    setTags(next);
    setDraft("");
    setProblem(undefined);
    return next;
  };
  const remove = (tag: string) => setTags(tags.filter((one) => one !== tag));
  return { tags, draft, setDraft, problem, add, remove };
}

function TagList({ tags, remove }: { tags: string[]; remove: (tag: string) => void }) {
  const { t } = useLingui();
  if (tags.length === 0) return null;
  return (
    <ul data-testid="edit-tags" className="flex flex-wrap gap-2">
      {tags.map((tag) => (
        <li key={tag} className="flex items-center gap-1 rounded-full border border-border ps-3 pe-1 text-sm">
          <DirText>{tag}</DirText>
          <PlainButton
            data-testid="edit-tag-remove"
            aria-label={t({ id: "media.edit.remove_tag", message: `Remove tag ${tag}` })}
            onPress={() => remove(tag)}
            className="size-6 pointer-coarse:size-11 rounded-full outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
          >
            ×
          </PlainButton>
        </li>
      ))}
    </ul>
  );
}

function EditForm({ medium, base, close, handlers }: FormProps) {
  const { t } = useLingui();
  const [name, setName] = useState(medium.file_name);
  const [tried, setTried] = useState(false);
  const tags = useTags(medium.tags);
  const fileName = name.trim();
  const nameOk = fileName !== "" && fileName.length <= NAME_MAX && !CONTROL.test(fileName);
  const save = useSend({
    send: (list: string[]) =>
      request(detailSchema, base, { method: "PATCH", body: { file_name: fileName, tags: list } }),
    done: (fresh) => {
      handlers.onSaved(fresh);
      close();
      toasts.show({ kind: "success", title: t({ id: "media.edit.saved", message: "Changes saved" }) });
    },
    settle: (error) => {
      if (error.status === 404) handlers.onGone();
      return error.status === 404;
    },
    lost: t({ id: "media.edit.failed.what", message: "We could not save your changes" }),
  });
  const submit = () => {
    setTried(true);
    const list = tags.add();
    if (nameOk && list) save.run(list);
  };
  return (
    <div data-testid="edit-dialog" className="flex flex-col gap-5">
      <TextField
        label={t({ id: "media.edit.name", message: "Name" })}
        testId="edit-name"
        value={name}
        onChange={setName}
        maxLength={NAME_MAX}
        {...(tried && !nameOk
          ? {
              errorMessage: t({
                id: "media.edit.name_invalid",
                message: "Enter a name of at most 255 characters, on one line.",
              }),
            }
          : {})}
      />
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <TextField
            label={t({ id: "media.edit.tag", message: "Add a tag" })}
            testId="edit-tag"
            value={tags.draft}
            onChange={tags.setDraft}
            {...(tags.problem === undefined ? {} : { errorMessage: tags.problem })}
          />
          <Button data-testid="edit-tag-add" onPress={tags.add}>
            <Trans id="media.edit.add_tag">Add</Trans>
          </Button>
        </div>
        <TagList tags={tags.tags} remove={tags.remove} />
      </div>
      {save.failure ? <ErrorPanel focusOnMount error={save.failure} {...saveCopy(save.failure)} /> : null}
      <div className="flex flex-wrap gap-3">
        <Button data-testid="edit-save" busy={save.busy} aria-disabled={save.busy} onPress={submit}>
          <Trans id="media.edit.save">Save</Trans>
        </Button>
        <Button data-testid="edit-cancel" onPress={close}>
          <Trans id="media.cancel">Cancel</Trans>
        </Button>
      </div>
    </div>
  );
}

function DeleteForm({ medium, base, close, handlers }: FormProps) {
  const { t } = useLingui();
  const name = medium.file_name;
  const remove = useSend({
    send: () => request(z.undefined(), base, { method: "DELETE", envelope: false }),
    done: () => {
      close();
      toasts.show({ kind: "success", title: t({ id: "media.delete.done", message: "File deleted" }) });
      handlers.onGone();
    },
    settle: (error) => {
      if (error.status === 404) {
        close();
        handlers.onGone();
        return true;
      }
      // The file's state changed: read it again so Delete shows why it is unavailable. A refused role is not read
      // again here, since that would take the dialog and its explanation off the screen.
      if (error.details?.reason === "not_deletable") handlers.readAgain();
      return false;
    },
    lost: t({ id: "media.delete.failed.what", message: "We could not delete this file" }),
  });
  return (
    <div data-testid="delete-dialog" className="flex flex-col gap-5">
      <p data-testid="delete-impact">
        <Trans id="media.delete.impact">
          <DirText>{name}</DirText> leaves the library and is deleted. This cannot be undone.
        </Trans>
      </p>
      {remove.failure ? (
        <div data-testid="delete-error">
          <ErrorPanel focusOnMount error={remove.failure} {...deleteCopy(remove.failure)} />
        </div>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button autoFocus data-testid="delete-cancel" onPress={close}>
          <Trans id="media.cancel">Cancel</Trans>
        </Button>
        <Button
          data-testid="delete-confirm"
          busy={remove.busy}
          aria-disabled={remove.busy}
          onPress={remove.run}
        >
          <Trans id="media.delete.confirm">Delete</Trans>
        </Button>
      </div>
    </div>
  );
}

function useDeleteReason(medium: Detail): string | undefined {
  const { t } = useLingui();
  const prefs = useFormatPrefs();
  const count = medium.post_count;
  const shown = formatNumber(count, prefs);
  if (count > 0)
    return t({
      id: "media.delete.in_use",
      message: plural(count, {
        one: `In use by ${shown} post: cannot delete`,
        other: `In use by ${shown} posts: cannot delete`,
      }),
    });
  if (!medium.actions.includes("delete"))
    return t({ id: "media.delete.not_now", message: "This file can be deleted once it is ready." });
  return undefined;
}

export function MediaActions({ medium, base, handlers }: Omit<FormProps, "close">) {
  const editing = useOpener();
  const deleting = useOpener();
  const reason = useDeleteReason(medium);
  if (!medium.actions.includes("edit")) return null;
  return (
    <div className="flex flex-wrap items-start gap-3">
      <Button ref={editing.ref} data-testid="detail-edit" onPress={() => editing.setOpen(true)}>
        <Trans id="media.edit.open">Edit</Trans>
      </Button>
      <Button
        ref={deleting.ref}
        data-testid="detail-delete"
        {...(reason === undefined ? {} : { "aria-disabled": true, reason })}
        onPress={() => deleting.setOpen(true)}
      >
        <Trans id="media.delete.open">Delete</Trans>
      </Button>
      <Dialog
        title={<Trans id="media.edit.title">Edit file</Trans>}
        isOpen={editing.open}
        onOpenChange={editing.setOpen}
      >
        <EditForm medium={medium} base={base} close={() => editing.setOpen(false)} handlers={handlers} />
      </Dialog>
      <Dialog
        title={<Trans id="media.delete.title">Delete this file?</Trans>}
        isOpen={deleting.open}
        onOpenChange={deleting.setOpen}
      >
        <DeleteForm medium={medium} base={base} close={() => deleting.setOpen(false)} handlers={handlers} />
      </Dialog>
    </div>
  );
}
