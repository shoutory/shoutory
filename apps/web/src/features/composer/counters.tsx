import { Trans, useLingui } from "@lingui/react/macro";
import { Button as PlainButton } from "react-aria-components";
import { DirText } from "../../ui/dir-text";
import { LocalizedNumber } from "../../ui/localized";
import { type Counter, type Issue, overBy } from "./composer-data";

function Warning() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-2">
      <path d="M12 3l10 18H2zM12 10v5M12 18v1" />
    </svg>
  );
}

export function CounterLine({ counters, testId }: { counters: readonly Counter[]; testId: string }) {
  if (counters.length === 0) return null;
  const over = overBy(counters);
  return (
    <span data-testid={testId} data-over={over > 0} className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {counters.map((counter) => (
        <span key={counter.kind}>
          {counter.kind === "length" ? (
            <Trans id="composer.counter.length">
              <LocalizedNumber value={counter.used} /> of <LocalizedNumber value={counter.limit} />
            </Trans>
          ) : (
            <Trans id="composer.counter.bytes">
              <LocalizedNumber value={counter.used} /> of <LocalizedNumber value={counter.limit} /> bytes
            </Trans>
          )}
        </span>
      ))}
      <span aria-live="polite" className="flex items-center gap-1 text-danger">
        {over > 0 ? (
          <>
            <Warning />
            <span data-testid={`${testId}-over`}>
              <Trans id="composer.counter.over">
                <LocalizedNumber value={over} /> over
              </Trans>
            </span>
          </>
        ) : null}
      </span>
    </span>
  );
}

export function useIssueWords() {
  const { t } = useLingui();
  return (issue: Issue, channel: string): string => {
    switch (issue.reason) {
      case "too_long":
        return t({ id: "composer.issue.too_long", message: `The text is too long for ${channel}` });
      case "empty":
        return t({ id: "composer.issue.empty", message: `Add text or a file for ${channel}` });
      case "too_many":
        return t({ id: "composer.issue.too_many", message: `There are too many files for ${channel}` });
      case "unsupported":
        return t({ id: "composer.issue.unsupported", message: `${channel} cannot post this type` });
      default:
        return t({ id: "composer.issue.other", message: `This does not fit ${channel}` });
    }
  };
}

export function ValidationPanel({
  issues,
  nameOf,
  onGo,
}: {
  issues: readonly Issue[];
  nameOf: (channelId: string) => string;
  onGo: (issue: Issue) => void;
}) {
  const words = useIssueWords();
  return (
    <section aria-labelledby="composer-checks" data-testid="composer-checks" className="flex flex-col gap-2">
      <h2 id="composer-checks" className="font-heading text-xl">
        <Trans id="composer.checks.title">Checks</Trans>
      </h2>
      <div role="status">
        {issues.length === 0 ? (
          <Trans id="composer.checks.ok">Nothing stops this post from being scheduled.</Trans>
        ) : (
          <ul className="flex flex-col gap-2">
            {issues.map((issue) => (
              <li
                key={`${issue.channelId}-${issue.key}-${issue.reason}`}
                data-testid="check-issue"
                className="flex flex-wrap items-center gap-3"
              >
                <Warning />
                <span>
                  <DirText>{words(issue, nameOf(issue.channelId))}</DirText>
                  {issue.over === undefined ? null : (
                    <>
                      {" "}
                      <Trans id="composer.counter.over">
                        <LocalizedNumber value={issue.over} /> over
                      </Trans>
                    </>
                  )}
                </span>
                <PlainButton
                  data-testid="check-go"
                  onPress={() => onGo(issue)}
                  className="min-h-6 pointer-coarse:min-h-11 text-link underline outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
                >
                  <Trans id="composer.checks.go">Go to field</Trans>
                </PlainButton>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
