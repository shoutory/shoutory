import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { z } from "zod";
import { useDigits } from "../account/prefs";
import { useLoad } from "../account/use-load";
import { formatNumber, type Locale } from "../i18n/i18n";
import { Listed } from "../settings/member-actions";
import { DirText } from "../ui/dir-text";
import { NotAvailable } from "./not-available";

const systemSchema = z.object({
  version: z.string().nullable(),
  channel: z.string(),
  migrations: z.object({ applied: z.number(), shipped: z.number(), pending: z.array(z.string()) }),
});
type System = z.infer<typeof systemSchema>;

const CHANNELS = {
  stable: msg({ id: "admin.releases.channel_stable", message: "Stable" }),
  beta: msg({ id: "admin.releases.channel_beta", message: "Beta" }),
  nightly: msg({ id: "admin.releases.channel_nightly", message: "Nightly" }),
} as const;

function MigrationStatus({ migrations }: { migrations: System["migrations"] }) {
  const { i18n } = useLingui();
  const digits = useDigits();
  const prefs = { locale: i18n.locale as Locale, digits };
  const applied = formatNumber(migrations.applied, prefs);
  const shipped = formatNumber(migrations.shipped, prefs);
  if (migrations.pending.length === 0)
    return (
      <Trans id="admin.releases.all_applied">
        All migrations are applied ({applied} of {shipped})
      </Trans>
    );
  return (
    <>
      <p>
        <Trans id="admin.releases.behind">
          Not applied yet: this instance is behind its build ({applied} of {shipped} applied).
        </Trans>
      </p>
      <ul>
        {migrations.pending.map((name) => (
          <li key={name}>
            <DirText dir="ltr">{name}</DirText>
          </li>
        ))}
      </ul>
    </>
  );
}

function Details({ system }: { system: System }) {
  const { i18n } = useLingui();
  const channel = CHANNELS[system.channel as keyof typeof CHANNELS];
  return (
    <dl className="flex max-w-md flex-col gap-3">
      <div>
        <dt className="font-medium">
          <Trans id="admin.releases.version">Version</Trans>
        </dt>
        <dd data-testid="release-version">
          {system.version ? <DirText dir="ltr">{system.version}</DirText> : <NotAvailable />}
        </dd>
      </div>
      <div>
        <dt className="font-medium">
          <Trans id="admin.releases.channel">Channel</Trans>
        </dt>
        <dd data-testid="release-channel" data-channel={system.channel}>
          {channel ? i18n._(channel) : system.channel}
        </dd>
      </div>
      <div>
        <dt className="font-medium">
          <Trans id="admin.releases.migrations">Database migrations</Trans>
        </dt>
        <dd data-testid="release-migrations">
          <MigrationStatus migrations={system.migrations} />
        </dd>
      </div>
    </dl>
  );
}

/** Z-07: the version, the channel and the migration status, with the update notice left quiet. */
export function ReleasesPage() {
  const { state, reload } = useLoad(systemSchema, "/api/v1/admin/system");
  return (
    <>
      <h1 className="font-heading text-2xl">
        <Trans id="admin.releases.title">Releases</Trans>
      </h1>
      <Listed state={state} reload={reload}>
        {(system) => <Details system={system} />}
      </Listed>
      <section data-kind="update-notice" className="max-w-prose text-text-muted">
        <Trans id="admin.releases.updates">
          Updates are not checked: this installation makes no outbound call to look for a new release.
        </Trans>
      </section>
    </>
  );
}
