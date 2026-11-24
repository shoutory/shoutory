import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { Button } from "./button";

interface Props {
  kind: "first-use" | "filtered-out" | "cleared";
  title: ReactNode;
  children?: ReactNode;
  action?: { label: string; onPress: () => void; testId?: string };
  onClearFilters?: () => void;
}

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
