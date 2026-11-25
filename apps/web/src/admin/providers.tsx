import { Trans, useLingui } from "@lingui/react/macro";
import { z } from "zod";
import { useLoad } from "../account/use-load";
import { Listed } from "../settings/member-actions";
import { DirText } from "../ui/dir-text";
import { EmptyState } from "../ui/empty-state";

const providerSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  lifecycle: z.enum(["beta", "ga"]),
  auth_kind: z.string(),
  needs_instance_host: z.boolean(),
  redirect_uri: z.string().nullable(),
});
const listSchema = z.array(providerSchema);
type Provider = z.infer<typeof providerSchema>;

function RedirectUri({ provider }: { provider: Provider }) {
  if (provider.redirect_uri === null) {
    return (
      <Trans id="admin.providers.per_server">
        Nothing to register: Shoutory registers itself on each server as a person connects.
      </Trans>
    );
  }
  return <DirText dir="ltr">{provider.redirect_uri}</DirText>;
}

function ProviderTable({ providers }: { providers: Provider[] }) {
  const { t } = useLingui();
  return (
    <div className="overflow-x-auto">
      <table
        aria-label={t({ id: "admin.providers.table", message: "Providers" })}
        className="w-full text-start"
      >
        <thead>
          <tr>
            <th className="pe-5 text-start">
              <Trans id="admin.providers.col_name">Provider</Trans>
            </th>
            <th className="pe-5 text-start">
              <Trans id="admin.providers.col_stage">Stage</Trans>
            </th>
            <th className="text-start">
              <Trans id="admin.providers.col_redirect">Redirect URI to register</Trans>
            </th>
          </tr>
        </thead>
        <tbody>
          {providers.map((provider) => (
            <tr key={provider.id}>
              <td className="py-2 pe-5">
                <DirText>{provider.display_name}</DirText>
              </td>
              <td className="py-2 pe-5">
                {provider.lifecycle === "beta" ? (
                  <Trans id="admin.providers.beta">Beta</Trans>
                ) : (
                  <Trans id="admin.providers.ga">Available</Trans>
                )}
              </td>
              <td className="py-2 wrap-anywhere">
                <RedirectUri provider={provider} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ProvidersPage() {
  const { state, reload } = useLoad(listSchema, "/api/v1/admin/providers");
  return (
    <>
      <h1 className="font-heading text-2xl">
        <Trans id="admin.providers.title">Provider apps</Trans>
      </h1>
      <p className="max-w-prose text-sm">
        <Trans id="admin.providers.intro">
          Register each provider's app with the redirect URI below. This screen changes nothing.
        </Trans>
      </p>
      <Listed state={state} reload={reload}>
        {(providers) =>
          providers.length === 0 ? (
            <EmptyState
              kind="first-use"
              title={<Trans id="admin.providers.empty_title">There are no providers in this build</Trans>}
            >
              <Trans id="admin.providers.empty_body">
                Each channel provider that needs an app of your own appears here once it ships.
              </Trans>
            </EmptyState>
          ) : (
            <ProviderTable providers={providers} />
          )
        }
      </Listed>
    </>
  );
}
