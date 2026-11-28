import { useLingui } from "@lingui/react/macro";
import type { Target } from "./post-facts";

type Attempt = NonNullable<Target["attempts"]>[number];

const word = (words: Readonly<Record<string, string>>, code: string, other: string): string =>
  Object.hasOwn(words, code) ? (words[code] as string) : other;

/** The name of a setting for a person: the keys providers declare today, and one plain word for any other. */
export function useSettingLabel(): (key: string) => string {
  const { t } = useLingui();
  const labels = {
    visibility: t({ id: "posts.setting.visibility", message: "Visibility" }),
    sensitive: t({ id: "posts.setting.sensitive", message: "Sensitive content" }),
    spoiler_text: t({ id: "posts.setting.spoiler_text", message: "Content warning" }),
  };
  const other = t({ id: "posts.setting.other", message: "Other setting" });
  return (key) => word(labels, key, other);
}

/** One attempt in words: what it did, what it may have sent, the status number as it came, and what went wrong. */
export function useAttemptWords(): (attempt: Attempt) => string[] {
  const { t } = useLingui();
  const steps = {
    prepare: t({ id: "posts.attempt.step.prepare", message: "Preparing" }),
    commit: t({ id: "posts.attempt.step.commit", message: "Sending" }),
    poll: t({ id: "posts.attempt.step.poll", message: "Checking progress" }),
    read_back: t({ id: "posts.attempt.step.read_back", message: "Reading it back" }),
  };
  const effects = {
    none: t({ id: "posts.attempt.effect.none", message: "nothing was sent" }),
    possible: t({ id: "posts.attempt.effect.possible", message: "may have been sent" }),
    confirmed: t({ id: "posts.attempt.effect.confirmed", message: "sent" }),
  };
  const failures = {
    retryable_before_send: t({
      id: "posts.attempt.error.retryable_before_send",
      message: "failed before sending, will retry",
    }),
    retryable_after_send: t({
      id: "posts.attempt.error.retryable_after_send",
      message: "failed after sending, will retry",
    }),
    rate_limited: t({ id: "posts.attempt.error.rate_limited", message: "rate limited" }),
    auth_revoked: t({ id: "posts.attempt.error.auth_revoked", message: "access was withdrawn" }),
    permanent: t({ id: "posts.attempt.error.permanent", message: "refused" }),
    unknown: t({ id: "posts.attempt.error.unknown", message: "unknown failure" }),
  };
  const other = t({ id: "posts.attempt.other", message: "Other" });
  return (attempt) => [
    word(steps, attempt.step, other),
    word(effects, attempt.effect, other),
    ...(attempt.http_status === null ? [] : [String(attempt.http_status)]),
    ...(attempt.error_class === null ? [] : [word(failures, attempt.error_class, other)]),
  ];
}
