import { Trans } from "@lingui/react/macro";
import { EmptyState } from "../ui/empty-state";

export function ProvidersPage() {
  return (
    <>
      <h1 className="font-heading text-2xl">
        <Trans id="admin.providers.title">Provider apps</Trans>
      </h1>
      <EmptyState
        kind="first-use"
        title={<Trans id="admin.providers.empty_title">There are no provider apps in this build</Trans>}
      >
        <Trans id="admin.providers.empty_body">
          Each channel provider that needs an app of your own appears here once it ships.
        </Trans>
      </EmptyState>
    </>
  );
}
