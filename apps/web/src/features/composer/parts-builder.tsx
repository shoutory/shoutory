import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../ui/button";
import { TextArea } from "../../ui/text-area";
import { countersOf, type Provider, type VariantDoc } from "./composer-data";
import { CounterLine } from "./counters";

const MAX_PARTS = 25;

interface Props {
  variant: VariantDoc;
  provider: Provider;
  readOnly: boolean;
  onChange: (change: Partial<VariantDoc>) => void;
  onBlur: () => void;
}

function moved(parts: readonly string[], from: number, by: number): string[] {
  const next = [...parts];
  const [part] = next.splice(from, 1);
  next.splice(from + by, 0, part ?? "");
  return next;
}

// Where focus goes once the list has been redrawn after a move or a delete: a kind of control and the part it is on.
type Focus = { control: "part-up" | "part-down" | "part-text" | "part-add"; at: number };

function useFocusAfterChange() {
  const root = useRef<HTMLElement>(null);
  const wanted = useRef<Focus | null>(null);
  useEffect(() => {
    const target = wanted.current;
    wanted.current = null;
    if (target === null) return;
    root.current?.querySelectorAll<HTMLElement>(`[data-testid="${target.control}"]`)[target.at]?.focus();
  });
  return {
    root,
    focusAfter: (focus: Focus) => {
      wanted.current = focus;
    },
  };
}

/** Ordered parts of a thread; each one is its own field, so each reads in its own direction. */
export function PartsBuilder({ variant, provider, readOnly, onChange, onBlur }: Props) {
  const { t } = useLingui();
  const parts = variant.threadParts;
  const [said, say] = useState("");
  const { root, focusAfter } = useFocusAfterChange();
  const set = (next: string[]) => onChange({ threadParts: next });
  const move = (at: number, by: -1 | 1) => {
    set(moved(parts, at, by));
    focusAfter({ control: by < 0 ? "part-up" : "part-down", at: at + by });
    const position = at + by + 1;
    const total = parts.length;
    say(t({ id: "composer.parts.moved", message: `Part moved to position ${position} of ${total}` }));
  };
  const remove = (at: number) => {
    set(parts.filter((_, place) => place !== at));
    focusAfter(
      parts.length === 1 ? { control: "part-add", at: 0 } : { control: "part-text", at: Math.max(at - 1, 0) },
    );
    say("");
  };
  const full = parts.length >= MAX_PARTS;
  return (
    <section ref={root} aria-labelledby={`parts-${variant.channelId}`} className="flex flex-col gap-3">
      <h3 id={`parts-${variant.channelId}`} className="font-medium">
        <Trans id="composer.parts.title">Thread parts</Trans>
      </h3>
      <p role="status" data-testid="parts-live" className="sr-only">
        {said}
      </p>
      <p className="text-sm text-text-muted">
        <Trans id="composer.parts.explain">This channel posts the parts as a thread.</Trans>
      </p>
      <ol className="flex flex-col gap-3">
        {parts.map((text, at) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a part has no identity but its place
          <li key={at} className="flex flex-col gap-2">
            <TextArea
              label={t({ id: "composer.parts.label", message: `Part ${at + 1}` })}
              testId="part-text"
              field={`parts.${at}:${variant.channelId}`}
              value={text}
              rows={3}
              isReadOnly={readOnly}
              onBlur={onBlur}
              onChange={(value) => set(parts.map((one, place) => (place === at ? value : one)))}
            />
            <CounterLine testId={`part-counter-${at}`} counters={countersOf(provider, text)} />
            {readOnly ? null : (
              <div className="flex flex-wrap gap-2">
                <Button data-testid="part-up" aria-disabled={at === 0} onPress={() => move(at, -1)}>
                  <Trans id="composer.parts.up">Move up</Trans>
                </Button>
                <Button
                  data-testid="part-down"
                  aria-disabled={at === parts.length - 1}
                  onPress={() => move(at, 1)}
                >
                  <Trans id="composer.parts.down">Move down</Trans>
                </Button>
                <Button data-testid="part-delete" onPress={() => remove(at)}>
                  <Trans id="composer.parts.delete">Delete part</Trans>
                </Button>
              </div>
            )}
          </li>
        ))}
      </ol>
      {readOnly ? null : (
        <div>
          <Button
            data-testid="part-add"
            aria-disabled={full}
            {...(full
              ? {
                  reason: t({
                    id: "composer.parts.full",
                    message: `A thread has at most ${MAX_PARTS} parts.`,
                  }),
                }
              : {})}
            onPress={() => set([...parts, ""])}
          >
            <Trans id="composer.parts.add">Add part</Trans>
          </Button>
        </div>
      )}
    </section>
  );
}

/** The comment posted under the post, only for channels whose network takes one. */
export function FirstComment({ variant, provider, readOnly, onChange, onBlur }: Props) {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-2">
      <TextArea
        label={t({ id: "composer.comment.label", message: "First comment" })}
        testId="first-comment"
        field={`parts.${variant.threadParts.length}:${variant.channelId}`}
        value={variant.firstComment}
        rows={3}
        isReadOnly={readOnly}
        onBlur={onBlur}
        onChange={(firstComment) => onChange({ firstComment })}
      />
      <CounterLine testId="comment-counter" counters={countersOf(provider, variant.firstComment)} />
    </div>
  );
}
