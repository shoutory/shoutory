import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { useParams } from "react-router";
import { z } from "zod";
import { useDigits } from "../account/prefs";
import { useLoad } from "../account/use-load";
import { authCopy } from "../auth/auth-copy";
import { formatNumber, type Locale } from "../i18n/i18n";
import { NotFoundPage } from "../pages/system-pages";
import { useShellData, type Workspace } from "../shell/shell-data";
import { EmptyState } from "../ui/empty-state";
import { ErrorPanel } from "../ui/error-panel";

const entitlement = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unlimited") }),
  z.object({ kind: z.literal("limited"), limit: z.number(), used: z.number() }),
]);
const limits = z.object({ workspaces: entitlement, members: entitlement });
type Entitlement = z.infer<typeof entitlement>;

// A limited entitlement shows its limit; the workspaces' use is shown too, as the plan counts it (the route's own
// `used`, which can differ from the clients this person reaches). Numbers follow the digits setting.
function Value({ value, meter }: { value: Entitlement; meter: boolean }) {
  const { t, i18n } = useLingui();
  const digits = useDigits();
  if (value.kind === "unlimited") return <Trans id="billing.unlimited">Unlimited</Trans>;
  const prefs = { locale: i18n.locale as Locale, digits };
  const limit = formatNumber(value.limit, prefs);
  if (!meter) return <Trans id="billing.up_to">Up to {limit}</Trans>;
  const used = formatNumber(value.used, prefs);
  const name = t({ id: "billing.workspaces", message: "Workspaces" });
  return (
    <span className="flex items-center gap-3">
      <meter aria-label={name} min={0} value={value.used} max={value.limit} />
      <Trans id="billing.used_of">
        {used} of {limit}
      </Trans>
    </span>
  );
}

function Row({ name, children }: { name: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="font-medium">{name}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// The limits are read through the organization's first workspace the person reaches (the interface is keyed by
// workspace).
function Usage({ workspace }: { workspace: Workspace }) {
  const { state, reload } = useLoad(limits, `/api/v1/workspaces/${workspace.id}/entitlements`);
  if (state.status === "loading")
    return (
      <p role="status">
        <Trans id="system.loading">Loading</Trans>
      </p>
    );
  if (state.status === "failed")
    return (
      <ErrorPanel focusOnMount error={state.error} onRetry={reload} {...authCopy("link", state.error)} />
    );
  return (
    <dl className="flex max-w-md flex-col gap-5">
      <Row name={<Trans id="billing.workspaces">Workspaces</Trans>}>
        <Value value={state.data.workspaces} meter />
      </Row>
      <Row name={<Trans id="billing.members">Members</Trans>}>
        <Value value={state.data.members} meter={false} />
      </Row>
    </dl>
  );
}

const BillingHeading = () => (
  <h1 className="font-heading text-2xl">
    <Trans id="billing.title">Billing</Trans>
  </h1>
);

/** O-10 (`/o/:org/billing`): what the plan allows and what is used. A personal organization has no such page. */
export function BillingPage() {
  const { org: id } = useParams();
  const data = useShellData();
  if ("error" in data) return <BillingHeading />;
  const org = data.organizations.find((candidate) => candidate.id === id);
  if (!org || org.type === "personal") return <NotFoundPage />;
  const clients = data.workspaces.filter((workspace) => workspace.organization_id === org.id);
  const first = clients[0];
  return (
    <>
      <BillingHeading />
      {first ? (
        <Usage workspace={first} />
      ) : (
        <EmptyState kind="first-use" title={<Trans id="billing.empty_title">Nothing to show yet</Trans>}>
          <Trans id="billing.empty_body">
            Usage appears once the organization has a client you can reach.
          </Trans>
        </EmptyState>
      )}
    </>
  );
}
