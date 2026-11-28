import { Trans, useLingui } from "@lingui/react/macro";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Form } from "react-aria-components";
import { z } from "zod";
import { useAction } from "../../auth/auth-frame";
import { useStepUp } from "../../auth/step-up";
import { type ApiError, request, uuidv7 } from "../../http/client";
import { Button } from "../../ui/button";
import { Choice, Choices } from "../../ui/choices";
import { Dialog } from "../../ui/dialog";
import { DirText } from "../../ui/dir-text";
import { ErrorPanel } from "../../ui/error-panel";
import { TextField } from "../../ui/text-field";
import { useSignIn } from "../channels/channels-hub";
import type { Place } from "./post-effects";
import {
  type Flavour,
  flavourOf,
  permalinkOf,
  RESOLUTIONS,
  type Resolution,
  type Target,
} from "./post-facts";
import type { Names } from "./post-names";
import { PostLink, refusalWords } from "./post-words";

const answerSchema = z.looseObject({ operation_id: z.string() });
const profileSchema = z.object({ default_tz: z.string() });

function useSentences() {
  const { t } = useLingui();
  return {
    attest_not_executed: t({
      id: "posts.resolve.ack.not_there",
      message: "I checked and it is not there; I understand posting again could create a duplicate",
    }),
    supersede: t({
      id: "posts.resolve.ack.replace",
      message: "I understand the first post may still appear and I may get a duplicate",
    }),
  } as Partial<Record<Resolution, string>>;
}

function Option({ kind }: { kind: Resolution }) {
  const words: Record<Resolution, [ReactNode, ReactNode]> = {
    attest_published: [
      <Trans id="posts.resolve.published.label" key="l">
        It was posted
      </Trans>,
      <Trans id="posts.resolve.published.line" key="n">
        It shows as published, confirmed by you. You can add the link.
      </Trans>,
    ],
    attest_not_executed: [
      <Trans id="posts.resolve.again.label" key="l">
        It was not posted, post it again
      </Trans>,
      <Trans id="posts.resolve.again.line" key="n">
        We post it again. If it did go out, you would get a duplicate.
      </Trans>,
    ],
    supersede: [
      <Trans id="posts.resolve.replace.label" key="l">
        Replace it
      </Trans>,
      <Trans id="posts.resolve.replace.line" key="n">
        We make a new post for this channel and keep watching for the first one. If it appears later you will
        be told.
      </Trans>,
    ],
    dismiss: [
      <Trans id="posts.resolve.leave.label" key="l">
        Leave it unconfirmed for now
      </Trans>,
      <Trans id="posts.resolve.leave.line" key="n">
        This channel stays blocked for new posts to it, and we remind you every week.
      </Trans>,
    ],
    publish_late: [
      <Trans id="posts.resolve.late.label" key="l">
        Publish now
      </Trans>,
      <Trans id="posts.resolve.late.line" key="n">
        We send it now, with a new deadline.
      </Trans>,
    ],
    reschedule: [
      <Trans id="posts.resolve.reschedule.label" key="l">
        Reschedule
      </Trans>,
      <Trans id="posts.resolve.reschedule.line" key="n">
        Pick a new time. The post goes back to scheduled.
      </Trans>,
    ],
    drop: [
      <Trans id="posts.resolve.drop.label" key="l">
        Drop it
      </Trans>,
      <Trans id="posts.resolve.drop.line" key="n">
        The post goes back to a draft. Nothing is deleted.
      </Trans>,
    ],
    confirm_removed: [
      <Trans id="posts.resolve.removed.label" key="l">
        Confirm it was removed
      </Trans>,
      <Trans id="posts.resolve.removed.line" key="n">
        Look at the channel first. This records that it is gone.
      </Trans>,
    ],
  };
  const [label, line] = words[kind];
  return (
    <span className="flex flex-col">
      <span className="font-medium">{label}</span>
      <span className="text-sm text-text-muted">{line}</span>
    </span>
  );
}

function ResultLine({ kind }: { kind: Resolution }) {
  const words: Record<Resolution, ReactNode> = {
    attest_published: (
      <Trans id="posts.resolve.done.published">Recorded as published. It shows as confirmed by you.</Trans>
    ),
    attest_not_executed: (
      <Trans id="posts.resolve.done.again">
        Sending it again. The channel shows its state as it changes.
      </Trans>
    ),
    supersede: (
      <Trans id="posts.resolve.done.replace">
        A new post was made. We keep watching for the first one and will tell you if it appears.
      </Trans>
    ),
    dismiss: (
      <Trans id="posts.resolve.done.leave">
        Kept as could not be confirmed. This channel stays blocked for new posts and we remind you every week.
      </Trans>
    ),
    publish_late: <Trans id="posts.resolve.done.late">Sending it now.</Trans>,
    reschedule: <Trans id="posts.resolve.done.reschedule">Rescheduled.</Trans>,
    drop: <Trans id="posts.resolve.done.drop">Moved back to a draft. Nothing was deleted.</Trans>,
    confirm_removed: (
      <Trans id="posts.resolve.done.removed">Recorded as removed. It shows as confirmed by you.</Trans>
    ),
  };
  return words[kind];
}

function Intro({ flavour, missed, named }: { flavour: Flavour; missed: boolean; named: Names }) {
  const place = <DirText>{named.channel}</DirText>;
  const platform = <DirText>{named.provider}</DirText>;
  if (flavour === "past_due" && missed) {
    return <Trans id="posts.resolve.intro.missed">Its time passed and we never send late.</Trans>;
  }
  if (flavour === "past_due") {
    return (
      <Trans id="posts.resolve.intro.past_due">
        {place} was disconnected when this was due. Posting it now would be late.
      </Trans>
    );
  }
  if (flavour === "removal") {
    return (
      <Trans id="posts.resolve.intro.removal">
        We could not confirm it was removed from {platform}. Open {platform} and look before you choose.
      </Trans>
    );
  }
  if (flavour === "unverified") {
    return (
      <Trans id="posts.resolve.intro.unverified">
        We stopped checking whether this was posted to {place}. It still blocks new posts to that channel.
      </Trans>
    );
  }
  return (
    <Trans id="posts.resolve.intro.unclear">
      We could not confirm whether this was posted to {place}. To avoid a duplicate we have not posted again.
      Open {place} and look for the post before you choose.
    </Trans>
  );
}

function Title({ flavour }: { flavour: Flavour }) {
  if (flavour === "past_due") {
    return <Trans id="posts.resolve.title_past_due">Nothing was posted; its time passed</Trans>;
  }
  if (flavour === "removal") {
    return <Trans id="posts.resolve.title_removal">We could not confirm it was removed</Trans>;
  }
  if (flavour === "unverified")
    return <Trans id="posts.resolve.title_unverified">Could not be confirmed</Trans>;
  return <Trans id="posts.resolve.title_unclear">We could not confirm whether this was posted</Trans>;
}

function TriggerWords({ flavour }: { flavour: Flavour }) {
  if (flavour === "past_due") return <Trans id="posts.resolve.open_past_due">Choose what to do</Trans>;
  if (flavour === "removal") return <Trans id="posts.resolve.open_removal">Confirm it was removed</Trans>;
  if (flavour === "unverified") return <Trans id="posts.resolve.open_unverified">Resolve</Trans>;
  return <Trans id="posts.resolve.open_unclear">Check and resolve</Trans>;
}

const zoneName = (zone: string, locale: string) =>
  new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: "long" })
    .formatToParts(new Date())
    .find((part) => part.type === "timeZoneName")?.value ?? zone;

// The workspace's own zone, read when a time has to be typed.
function useZone(ws: string, wanted: boolean): string | null {
  const [zone, setZone] = useState<string | null>(null);
  useEffect(() => {
    if (!wanted || zone !== null) return;
    let live = true;
    request(profileSchema, `/api/v1/workspaces/${ws}`).then(
      (profile) => live && setZone(profile.default_tz),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [ws, wanted, zone]);
  return zone;
}

const TIME_REASONS: Readonly<Record<string, string>> = {
  local_time_nonexistent: "gap",
  local_time_ambiguous: "fold",
  in_the_past: "past",
  invalid_local: "missing",
};

interface Fields {
  ack: string;
  link: string;
  date: string;
  time: string;
  fold: "earlier" | "later" | null;
}
type Problem = "ack" | "link" | "missing" | "gap" | "fold" | "past" | null;

function problemOf(kind: Resolution | "", fields: Fields, sentence: string | undefined): Problem {
  if (sentence !== undefined && fields.ack.trim() !== sentence) return "ack";
  if (
    kind === "attest_published" &&
    fields.link.trim() !== "" &&
    !/^https:\/\/\S+$/.test(fields.link.trim())
  ) {
    return "link";
  }
  return kind === "reschedule" && (fields.date === "" || fields.time === "") ? "missing" : null;
}

function bodyOf(kind: Resolution, fields: Fields, sentence: string | undefined) {
  return {
    kind,
    ...(sentence === undefined ? {} : { ack_text: fields.ack.trim() }),
    ...(kind === "attest_published" && fields.link.trim() !== "" ? { permalink: fields.link.trim() } : {}),
    ...(kind === "reschedule" ? { local_due: `${fields.date}T${fields.time}` } : {}),
    ...(kind === "reschedule" && fields.fold !== null ? { fold: fields.fold } : {}),
  };
}

function useResolve(
  place: Place,
  target: Target,
  stepUps: ReadonlySet<Resolution>,
  onDone: (kind: Resolution) => void,
) {
  const stepUp = useStepUp();
  const signIn = useSignIn();
  const sentences = useSentences();
  const [kind, setKind] = useState<Resolution | "">("");
  const [fields, setFields] = useState<Fields>({ ack: "", link: "", date: "", time: "", fold: null });
  const [problem, setProblem] = useState<Problem>(null);
  const sentence = kind === "" ? undefined : sentences[kind];
  const action = useAction(
    async () => {
      if (kind === "") return;
      const path = `/api/v1/workspaces/${place.ws}/operations/${target.operation?.id}/resolutions`;
      const stepped = stepUps.has(kind);
      const go = () =>
        request(answerSchema, stepped ? `${path}/confirmed` : path, {
          method: "POST",
          body: bodyOf(kind, fields, sentence),
          idempotencyKey: uuidv7(),
        });
      await (stepped ? stepUp(go) : go());
      place.refresh();
      onDone(kind);
    },
    (error) => {
      if (error.state === "session_expired") return signIn();
      const reason = TIME_REASONS[error.details?.reason ?? ""];
      setProblem(reason !== undefined && kind === "reschedule" ? (reason as Problem) : null);
      if (error.status === 409 || error.status === 412) place.refresh();
    },
  );
  const submit = () => {
    const found = problemOf(kind, fields, sentence);
    setProblem(found);
    if (found === null) void action.run();
  };
  const edit = (change: Partial<Fields>) => {
    setFields((now) => ({ ...now, ...change }));
    setProblem(null);
  };
  return { kind, setKind, fields, edit, problem, sentence, action, submit };
}

function failureWords(error: ApiError, channel: string) {
  if (error.code === "step_up_required") {
    return {
      what: <Trans id="posts.resolve.step_up.what">This choice needs your password again</Trans>,
      meaning: <Trans id="posts.resolve.step_up.meaning">Nothing was changed.</Trans>,
    };
  }
  if (error.details?.reason === "channel_not_connected") {
    return {
      what: (
        <Trans id="posts.resolve.not_connected.what">
          Reconnect <DirText>{channel}</DirText> first
        </Trans>
      ),
      meaning: (
        <Trans id="posts.resolve.not_connected.meaning">
          This choice would send the post, and the channel is not connected. Nothing was changed.
        </Trans>
      ),
    };
  }
  return refusalWords(error);
}

type Resolve = ReturnType<typeof useResolve>;

function Extras({ r, zone }: { r: Resolve; zone: string | null }) {
  return (
    <>
      {r.sentence === undefined ? null : <AckField r={r} sentence={r.sentence} />}
      {r.kind === "attest_published" ? <LinkField r={r} /> : null}
      {r.kind === "reschedule" ? <TimeFields r={r} zone={zone} /> : null}
    </>
  );
}

function AckField({ r, sentence }: { r: Resolve; sentence: string }) {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-2">
      <p data-testid="resolve-ack-sentence" className="font-medium">
        {sentence}
      </p>
      <TextField
        testId="resolve-ack"
        label={t({ id: "posts.resolve.ack.label", message: "Type that sentence to confirm" })}
        value={r.fields.ack}
        onChange={(ack) => r.edit({ ack })}
        {...(r.problem === "ack"
          ? {
              errorMessage: t({
                id: "posts.resolve.ack.error",
                message: "Type the sentence exactly as shown.",
              }),
            }
          : {})}
      />
    </div>
  );
}

function LinkField({ r }: { r: Resolve }) {
  const { t } = useLingui();
  return (
    <TextField
      testId="resolve-permalink"
      ltr
      label={t({ id: "posts.resolve.link.label", message: "Link to the post (optional)" })}
      value={r.fields.link}
      onChange={(link) => r.edit({ link })}
      {...(r.problem === "link"
        ? {
            errorMessage: t({
              id: "posts.resolve.link.error",
              message: "Use an address that starts with https://",
            }),
          }
        : {})}
    />
  );
}

function TimeFields({ r, zone }: { r: Resolve; zone: string | null }) {
  const { t, i18n } = useLingui();
  const { fields, edit, problem } = r;
  const timeWords: Record<string, string> = {
    missing: t({ id: "posts.resolve.time.missing", message: "Enter a date and a time." }),
    gap: t({
      id: "posts.resolve.time.gap",
      message: "That time does not exist on that day, because the clocks skip it. Pick another time.",
    }),
    fold: t({
      id: "posts.resolve.time.fold",
      message: "That time happens twice that day. Pick the earlier or the later one.",
    }),
    past: t({ id: "posts.resolve.time.past", message: "Pick a time in the future." }),
  };
  const timeError = problem !== null && problem in timeWords ? timeWords[problem] : undefined;
  return (
    <fieldset className="flex flex-col gap-3">
      {zone === null ? null : (
        <p className="text-sm">
          <Trans id="posts.resolve.zone">
            Times use the time zone of this workspace: <DirText>{zoneName(zone, i18n.locale)}</DirText>
          </Trans>
        </p>
      )}
      <TextField
        testId="resolve-date"
        type="date"
        label={t({ id: "posts.resolve.date", message: "Date" })}
        value={fields.date}
        onChange={(date) => edit({ date })}
      />
      <TextField
        testId="resolve-time"
        type="time"
        label={t({ id: "posts.resolve.time", message: "Time" })}
        value={fields.time}
        onChange={(time) => edit({ time })}
        {...(timeError === undefined ? {} : { errorMessage: timeError })}
      />
      {problem === "fold" || fields.fold !== null ? <FoldChoice r={r} /> : null}
    </fieldset>
  );
}

function FoldChoice({ r }: { r: ReturnType<typeof useResolve> }) {
  return (
    <Choices
      label={<Trans id="posts.resolve.fold.label">Which of the two times?</Trans>}
      value={r.fields.fold ?? ""}
      onChange={(fold) => r.edit({ fold: fold === "earlier" ? "earlier" : "later" })}
    >
      <Choice value="earlier" testId="resolve-fold-earlier">
        <Trans id="posts.resolve.fold.earlier">The earlier one</Trans>
      </Choice>
      <Choice value="later" testId="resolve-fold-later">
        <Trans id="posts.resolve.fold.later">The later one</Trans>
      </Choice>
    </Choices>
  );
}

function ChoiceList({ r, kinds }: { r: ReturnType<typeof useResolve>; kinds: Resolution[] }) {
  if (kinds.length === 0) {
    return (
      <p>
        <Trans id="posts.resolve.none">
          There is nothing to choose for this one right now. We keep checking.
        </Trans>
      </p>
    );
  }
  return (
    <Choices
      label={<Trans id="posts.resolve.choose">What happened?</Trans>}
      value={r.kind}
      onChange={(next) => {
        r.setKind(kinds.find((one) => one === next) ?? "");
        r.edit({});
      }}
    >
      {kinds.map((kind) => (
        <Choice key={kind} value={kind} testId={`resolve-choice-${kind}`}>
          <Option kind={kind} />
        </Choice>
      ))}
    </Choices>
  );
}

function Submit({ r }: { r: ReturnType<typeof useResolve> }) {
  const { t } = useLingui();
  return (
    <Button
      type="submit"
      data-testid="resolve-submit"
      busy={r.action.pending}
      aria-disabled={r.kind === "" || r.action.pending || !r.action.online}
      {...(r.action.online
        ? {}
        : { reason: t({ id: "auth.offline", message: "You are offline. This needs the server." }) })}
    >
      <Trans id="posts.resolve.submit">Continue</Trans>
    </Button>
  );
}

function Body({ place, target, named, flavour, kinds, stepUps, onDone }: BodyProps) {
  const r = useResolve(place, target, stepUps, onDone);
  const zone = useZone(place.ws, r.kind === "reschedule");
  const address = permalinkOf(target.evidence);
  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault();
        r.submit();
      }}
      className="flex flex-col gap-5"
    >
      <p>
        <Intro flavour={flavour} missed={target.operation?.state === "missed"} named={named} />
      </p>
      {address === null ? null : <PostLink address={address} provider={named.provider} />}
      <ChoiceList r={r} kinds={kinds} />
      <Extras r={r} zone={zone} />
      {r.action.failure && !(r.problem !== null && r.kind === "reschedule") ? (
        <div data-testid="resolve-error">
          <ErrorPanel
            focusOnMount
            error={r.action.failure}
            {...failureWords(r.action.failure, named.channel)}
          />
        </div>
      ) : null}
      {kinds.length === 0 ? null : <Submit r={r} />}
    </Form>
  );
}

interface BodyProps {
  place: Place;
  target: Target;
  named: Names;
  flavour: Flavour;
  kinds: Resolution[];
  /** The kinds the server asks a fresh password for. */
  stepUps: ReadonlySet<Resolution>;
  onDone: (kind: Resolution) => void;
}

interface ButtonProps {
  place: Place;
  target: Target;
  named: Names;
  /** Kept by the row, so the answer stays on screen after the server stops listing the action. */
  done: Resolution | null;
  onDone: (kind: Resolution | null) => void;
}

export function ResolveButton({ place, target, named, done, onDone: setDone }: ButtonProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) trigger.current?.focus();
    wasOpen.current = open;
  }, [open]);
  if (target.operation === null) return null;
  const flavour = flavourOf(target.operation);
  const listed = target.operation.resolutions.filter((one): one is { kind: Resolution; step_up: boolean } =>
    RESOLUTIONS.some((kind) => kind === one.kind),
  );
  const kinds = listed.map((one) => one.kind);
  const stepUps = new Set(listed.filter((one) => one.step_up).map((one) => one.kind));
  return (
    <>
      <Button ref={trigger} data-testid="action-resolve" onPress={() => setOpen(true)}>
        <TriggerWords flavour={flavour} />
      </Button>
      <Dialog
        isOpen={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setDone(null);
        }}
        title={<Title flavour={flavour} />}
      >
        <div data-testid="resolve-dialog" className="flex flex-col gap-5">
          {done === null ? (
            <Body
              place={place}
              target={target}
              named={named}
              flavour={flavour}
              kinds={kinds}
              stepUps={stepUps}
              onDone={setDone}
            />
          ) : (
            <p data-testid="resolve-result" role="status" className="font-medium">
              <ResultLine kind={done} />
            </p>
          )}
          <div>
            <Button
              data-testid="resolve-cancel"
              onPress={() => {
                setOpen(false);
                setDone(null);
              }}
            >
              {done === null ? (
                <Trans id="posts.action.cancel">Cancel</Trans>
              ) : (
                <Trans id="posts.resolve.close">Close</Trans>
              )}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
