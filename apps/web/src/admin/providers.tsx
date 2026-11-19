import { Trans } from "@lingui/react/macro";
import { EmptyState } from "../ui/empty-state";

/** Z-04: the provider apps of this installation. This build has none, so the screen says so and reads nothing. */
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
