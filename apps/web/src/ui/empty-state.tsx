import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { Button } from "./button";

interface Props {
  kind: "first-use" | "filtered-out" | "cleared";
  title: ReactNode;
  children?: ReactNode;
  /** The one primary action of the first-use kind. */
  action?: { label: string; onPress: () => void; testId?: string };
  /** The Clear filters action of the filtered-out kind. */
  onClearFilters?: () => void;
}

/**
 * The three empty states (ux-spec 2.1 E), worded differently and never an alert: first-use explains the thing and has
 * one primary action, filtered-out offers Clear filters, cleared is positive and has no action.
 */
export function EmptyState(props: Props) {
  return (
    <section data-kind={props.kind} className="flex flex-col items-start gap-3 py-8">
      <h2 className="font-heading text-xl">{props.title}</h2>
      {props.children ? <p className="text-text-muted">{props.children}</p> : null}
      {props.kind === "first-use" && props.action ? (
        <Button data-testid={props.action.testId} onPress={props.action.onPress}>
          {props.action.label}
        </Button>
      ) : null}
      {props.kind === "filtered-out" && props.onClearFilters ? (
        <Button onPress={props.onClearFilters}>
          <Trans id="system.empty.clear_filters">Clear filters</Trans>
        </Button>
      ) : null}
    </section>
  );
}
