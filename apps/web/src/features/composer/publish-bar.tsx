import { Trans, useLingui } from "@lingui/react/macro";
import { type Dispatch, type SetStateAction, useCallback, useState } from "react";
import { useNavigate } from "react-router";
import { z } from "zod";
import { useActions } from "../../auth/auth-frame";
import { ApiError, keyedPost } from "../../http/client";
import { formatDate } from "../../i18n/i18n";
import { Banner } from "../../ui/banner";
import { Button } from "../../ui/button";
import { Choice, Choices } from "../../ui/choices";
import { LocalizedDateTime, useFormatPrefs } from "../../ui/localized";
import { TextField } from "../../ui/text-field";
import { cityOf } from "../../zones/zone-picker";
import { type Issue, type Target, wallClock } from "./composer-data";
import type { SaveState } from "./composer-save";
import { idsSchema, scheduledSchema } from "./publish-calls";
import { PublishRefusal } from "./publish-refusal";

const issueSchema = z.array(z.object({ variant: z.number(), key: z.string(), reason: z.string() }));

export interface PublishProps {
  workspace: string;
  postId: string | undefined;
  zone: string;
  selected: readonly string[];
  targets: readonly Target[];
  channelOk: (channelId: string) => boolean;
  issues: readonly Issue[];
  saveState: SaveState;
  online: boolean;
  pending: readonly string[];
  saveNow: () => Promise<boolean>;
  onIssues: (issues: Issue[]) => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onChanged: () => void;
}

function eligible(props: PublishProps, action: string): Target[] {
  return props.selected.flatMap((channel) => {
    const target = props.targets.find((one) => one.channel_id === channel);
    return target?.actions.includes(action) ? [target] : [];
  });
}

type Availability = { ids: string[]; reason: null } | { ids: []; reason: string };

// Whether an action can be taken now: the server lists it for the target, the channel is connected, the draft is saved
// and nothing in the checks blocks it. The reason is shown beside the button that is not available.
function useAvailability(props: PublishProps): (action: string) => Availability {
  const { t } = useLingui();
  return (action) => {
    const to = (reason: string): Availability => ({ ids: [], reason });
    const covered = props.selected.every((id) => props.targets.some((target) => target.channel_id === id));
    if (!props.online)
      return to(t({ id: "auth.offline", message: "You are offline. This needs the server." }));
    if (props.postId === undefined || !covered || props.saveState !== "saved") {
      return to(t({ id: "composer.publish.wait_save", message: "Wait for your changes to be saved first." }));
    }
    const shown = eligible(props, action);
    if (shown.length === 0) {
      return to(
        t({ id: "composer.publish.nothing", message: "Nothing in this post can be sent from here." }),
      );
    }
    const usable = shown.filter((target) => props.channelOk(target.channel_id));
    if (usable.length === 0) return to(t({ id: "composer.publish.reconnect", message: "Reconnect needed" }));
    const channels = new Set(usable.map((target) => target.channel_id));
    const blocking = props.issues.filter((issue) => channels.has(issue.channelId)).length;
    if (blocking > 0) {
      return to(t({ id: "composer.publish.fix", message: `Fix ${blocking} problems in the checks first.` }));
    }
    return { ids: usable.map((target) => target.variant_id), reason: null };
  };
}

function ScheduleField({
  zone,
  value,
  onChange,
  problem,
  fold,
  onFold,
}: {
  zone: string;
  value: string;
  onChange: (value: string) => void;
  problem: string | null;
  fold: string;
  onFold: (fold: string) => void;
}) {
  const { t, i18n } = useLingui();
  const prefs = useFormatPrefs();
  const city = cityOf(zone, i18n.locale === "ar" ? "ar" : "en");
  const day = value.slice(0, 10);
  const date = /^\d{4}-\d\d-\d\d$/.test(day) ? formatDate(new Date(`${day}T12:00:00Z`), prefs, "UTC") : day;
  const words: Record<string, string> = {
    passed: t({
      id: "composer.schedule.passed",
      message: "That time has passed. Pick a later time or publish now.",
    }),
    local_time_nonexistent: t({
      id: "composer.schedule.gap",
      message: `This time does not exist on ${date}. Pick another time`,
    }),
    local_time_ambiguous: t({
      id: "composer.schedule.fold",
      message: "That time happens twice. Choose which one.",
    }),
    invalid_local: t({ id: "composer.schedule.invalid", message: "Enter a date and a time." }),
  };
  return (
    <div data-testid="schedule-problem" className="flex flex-col gap-3">
      <TextField
        type="datetime-local"
        ltr
        testId="schedule-when"
        label={t({ id: "composer.schedule.label", message: `Date and time (Time zone: ${city})` })}
        value={value}
        onChange={onChange}
        {...(problem === null ? {} : { errorMessage: words[problem] ?? words.invalid_local ?? "" })}
      />
      {problem === "local_time_ambiguous" ? (
        <Choices
          label={t({ id: "composer.schedule.fold_label", message: "Which one" })}
          value={fold}
          onChange={onFold}
        >
          <Choice value="earlier" testId="fold-earlier">
            <Trans id="composer.schedule.earlier">Earlier</Trans>
          </Choice>
          <Choice value="later" testId="fold-later">
            <Trans id="composer.schedule.later">Later</Trans>
          </Choice>
        </Choices>
      ) : null}
    </div>
  );
}

// The wall time to show first: that of a variant already scheduled, so "Update schedule" keeps the time.
function firstLocal(targets: readonly Target[], selected: readonly string[]): string {
  const due = targets.find(
    (target) => selected.includes(target.channel_id) && target.due_at && target.due_tz,
  );
  return due?.due_at && due.due_tz ? wallClock(due.due_tz, new Date(due.due_at)) : "";
}

const INLINE = new Set(["local_time_nonexistent", "local_time_ambiguous", "invalid_local", "in_the_past"]);

function problemOf(passed: boolean, reason: string): string | null {
  if (passed || reason === "in_the_past") return "passed";
  return INLINE.has(reason) ? reason : null;
}

// `started` is set when an Undo found that the sending had begun.
type Sent = { ids: string[]; started: boolean } | null;

interface Scheduled {
  at: Date;
  zone: string;
}

// The checks the server's strict answer names, by variant position in the order the targets were sent.
function issuesOfRefusal(error: ApiError, order: readonly Target[]): Issue[] {
  const list = issueSchema.safeParse(error.lists?.issues);
  if (error.details?.reason !== "variant_invalid" || !list.success) return [];
  return list.data.flatMap((one) => {
    const channelId = order[one.variant]?.channel_id;
    return channelId ? [{ channelId, key: one.key, reason: one.reason }] : [];
  });
}

// A strict refusal puts its checks under the fields; the error itself is still raised to be shown.
function shown(props: PublishProps, error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  const order = eligible(props, "schedule").filter((one) => props.channelOk(one.channel_id));
  props.onIssues(issuesOfRefusal(error, order));
  return error;
}

// The time being chosen, and whether it has passed or needs a choice between its two occurrences.
function useWhen(props: PublishProps, clear: () => void) {
  const [local, setLocal] = useState(() => firstLocal(props.targets, props.selected));
  const [fold, setFold] = useState("");
  const [passed, setPassed] = useState(false);
  const change = (value: string) => {
    setLocal(value);
    setPassed(false);
    setFold("");
    clear();
  };
  return { local, fold, setFold, passed, setPassed, change };
}

// An update names only the variants whose change is not scheduled yet; a first schedule names them all.
function scheduleBody(
  pending: readonly string[],
  all: readonly string[],
  when: { local: string; fold: string },
) {
  const named = pending.length > 0 ? all.filter((id) => pending.includes(id)) : all;
  return {
    local_due: when.local,
    variant_ids: named.length > 0 ? named : all,
    ...(when.fold ? { fold: when.fold } : {}),
  };
}

function usePublishActions(props: PublishProps, setSent: Dispatch<SetStateAction<Sent>>, sent: Sent) {
  const call = useActions();
  const [post] = useState(keyedPost);
  const availability = useAvailability(props);
  const when = useWhen(props, call.reset);
  const [scheduled, setScheduled] = useState<Scheduled | null>(null);
  const base = `/api/v1/workspaces/${props.workspace}/posts/${props.postId}`;

  const schedule = () =>
    call.run("schedule", async () => {
      if (when.local === "" || when.local <= wallClock(props.zone, new Date())) return when.setPassed(true);
      if (!(await props.saveNow())) return;
      const body = scheduleBody(props.pending, availability("schedule").ids, when);
      const done = await post(scheduledSchema, `${base}/schedule`, body).catch((error: unknown) => {
        throw shown(props, error);
      });
      setScheduled({ at: new Date(done.due_at), zone: done.due_tz });
    });

  const publish = () =>
    call.run("publish", async () => {
      if (!(await props.saveNow())) return;
      const body = { variant_ids: availability("publish_now").ids };
      const done = await post(idsSchema, `${base}/publish`, body);
      setSent({ ids: done.variant_ids, started: false });
    });

  // Sending that has begun cannot be undone here; the refusal is an answer, shown with the Cancel the server lists.
  const undo = () =>
    call.run("undo", async () => {
      try {
        await post(idsSchema, `${base}/unschedule`, { variant_ids: sent?.ids ?? [] });
      } catch (error) {
        if (!(error instanceof ApiError) || error.details?.reason !== "post_in_flight") throw error;
        setSent((now) => now && { ...now, started: true });
        props.onChanged();
        return;
      }
      setSent(null);
      props.onChanged();
    });

  const cancellable = props.targets.flatMap((target) =>
    sent?.ids.includes(target.variant_id) && target.actions.includes("cancel") && target.operation
      ? [target.operation.id]
      : [],
  );
  const cancel = () =>
    call.run("cancel", async () => {
      for (const id of cancellable) {
        await post(z.looseObject({}), `/api/v1/workspaces/${props.workspace}/operations/${id}/cancel`, {});
      }
      setSent(null);
      props.onChanged();
    });

  return { call, availability, when, scheduled, schedule, publish, undo, cancel, cancellable };
}

function Result({ scheduled, open }: { scheduled: Scheduled; open: () => void }) {
  const { i18n } = useLingui();
  return (
    <Banner tone="info" announce={false}>
      <div data-testid="schedule-done" className="flex flex-wrap items-center gap-3">
        <span>
          <Trans id="composer.publish.scheduled">
            Scheduled for <LocalizedDateTime value={scheduled.at} timeZone={scheduled.zone} /> (
            {cityOf(scheduled.zone, i18n.locale === "ar" ? "ar" : "en")})
          </Trans>
        </span>
        <Button data-testid="schedule-open" onPress={open}>
          <Trans id="composer.publish.open">Open post</Trans>
        </Button>
      </div>
    </Banner>
  );
}

function Sending({ actions, started, open }: { actions: Actions; started: boolean; open: () => void }) {
  const { call } = actions;
  return (
    <Banner tone="info" announce={false}>
      <div data-testid="publish-sent" className="flex flex-wrap items-center gap-3">
        <span>
          <Trans id="composer.publish.sent">Sent to the queue</Trans>
        </span>
        {started ? (
          <>
            <span data-testid="publish-started">
              <Trans id="composer.publish.started">
                It has started sending, so it can no longer be taken back here.
              </Trans>
            </span>
            {actions.cancellable.length === 0 ? null : (
              <Button
                data-testid="publish-cancel"
                busy={call.busy === "cancel"}
                onPress={() => void actions.cancel()}
              >
                <Trans id="posts.action.cancel">Cancel</Trans>
              </Button>
            )}
          </>
        ) : (
          <Button data-testid="publish-undo" busy={call.busy === "undo"} onPress={() => void actions.undo()}>
            <Trans id="composer.publish.undo">Undo (until sending starts)</Trans>
          </Button>
        )}
        <Button data-testid="publish-open" onPress={open}>
          <Trans id="composer.publish.open">Open post</Trans>
        </Button>
      </div>
    </Banner>
  );
}

function Failure({ props, error }: { props: PublishProps; error: ApiError }) {
  const { t } = useLingui();
  const reason = error.details?.reason ?? "";
  if (INLINE.has(reason)) return null;
  if (reason === "variant_invalid") {
    return (
      <p role="alert">
        {t({
          id: "composer.publish.invalid",
          message: "Some channels need changes before this can be sent. Nothing was scheduled.",
        })}
      </p>
    );
  }
  return (
    <PublishRefusal
      testId="schedule-failure"
      error={error}
      onEdit={props.onEdit}
      onDuplicate={props.onDuplicate}
    />
  );
}

type Actions = ReturnType<typeof usePublishActions>;

function Buttons({ actions, updating }: { actions: Actions; updating: boolean }) {
  const { call, availability } = actions;
  const when = availability("schedule");
  const now = availability("publish_now");
  return (
    <>
      <div className="flex flex-wrap items-start gap-3">
        <Button
          data-testid="schedule-submit"
          busy={call.busy === "schedule"}
          aria-disabled={when.reason !== null}
          {...(when.reason === null ? {} : { reason: when.reason })}
          onPress={() => void actions.schedule()}
        >
          {updating ? (
            <Trans id="composer.publish.update">Update schedule</Trans>
          ) : (
            <Trans id="composer.publish.schedule">Schedule</Trans>
          )}
        </Button>
        <Button
          data-testid="publish-now"
          busy={call.busy === "publish"}
          aria-disabled={now.reason !== null}
          {...(now.reason === null ? {} : { reason: now.reason })}
          onPress={() => void actions.publish()}
        >
          <Trans id="composer.publish.now">Publish now</Trans>
        </Button>
      </div>
      {now.ids.length >= 3 ? (
        <p>
          <Trans id="composer.publish.summary">This posts to {now.ids.length} channels now.</Trans>
        </p>
      ) : null}
    </>
  );
}

export function PublishBar(props: PublishProps) {
  const navigate = useNavigate();
  const [sent, setSent] = useState<Sent>(null);
  const actions = usePublishActions(props, setSent, sent);
  const { call, scheduled } = actions;
  const detail = `/w/${props.workspace}/posts/${props.postId}`;
  const open = useCallback(() => void navigate(detail), [navigate, detail]);
  const problem = problemOf(actions.when.passed, call.failure?.details?.reason ?? "");
  return (
    <section aria-labelledby="composer-publish" className="flex flex-col gap-4">
      <h2 id="composer-publish" className="font-heading text-xl">
        <Trans id="composer.publish.title">Schedule</Trans>
      </h2>
      <div role="status" data-testid="publish-live">
        {scheduled !== null ? <Result scheduled={scheduled} open={open} /> : null}
        {scheduled === null && sent !== null ? (
          <Sending actions={actions} started={sent.started} open={open} />
        ) : null}
      </div>
      {scheduled === null && sent === null ? (
        <>
          <ScheduleField
            zone={props.zone}
            value={actions.when.local}
            onChange={actions.when.change}
            problem={problem}
            fold={actions.when.fold}
            onFold={actions.when.setFold}
          />
          <Buttons actions={actions} updating={props.pending.length > 0} />
        </>
      ) : null}
      {call.failure ? <Failure props={props} error={call.failure} /> : null}
    </section>
  );
}
