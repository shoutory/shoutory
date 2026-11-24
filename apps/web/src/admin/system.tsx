import { Trans } from "@lingui/react/macro";
import { type ReactNode, useState } from "react";
import { type ZodType, z } from "zod";
import { useStepUp } from "../auth/step-up";
import { request } from "../http/client";
import { changeCopy, useChange } from "../settings/member-actions";
import { Button } from "../ui/button";
import { DirText } from "../ui/dir-text";
import { ErrorPanel } from "../ui/error-panel";

const storageSchema = z.object({
  driver: z.string(),
  writable: z.boolean(),
  readable: z.boolean(),
  failure: z.enum(["write_failed", "read_failed", "delete_failed", "timeout"]).nullable(),
});
const dnsSchema = z.object({
  domain: z.string().nullable(),
  records: z.array(
    z.object({
      kind: z.string(),
      state: z.enum(["present", "missing", "unchecked", "not_checked"]),
      name: z.string(),
    }),
  ),
});
const queuedSchema = z.object({ queued: z.boolean() });

function useCheck<T>(schema: ZodType<T>, path: string, needsPassword: boolean) {
  const stepUp = useStepUp();
  const [result, setResult] = useState<T | null>(null);
  const run = useChange(async () => {
    setResult(null);
    const call = () => request(schema, path, { method: "POST" });
    setResult(await (needsPassword ? stepUp(call) : call()));
  });
  return { result, ...run };
}

function Section({
  title,
  intro,
  button,
  check,
  children,
}: {
  title: ReactNode;
  intro: ReactNode;
  button: ReactNode;
  check: { run: () => Promise<void>; pending: boolean; failure: Parameters<typeof changeCopy>[0] | null };
  children: ReactNode;
}) {
  return (
    <section className="flex max-w-prose flex-col gap-3">
      <h2 className="font-heading text-xl">{title}</h2>
      <p className="text-text-muted">{intro}</p>
      <div>
        <Button busy={check.pending} aria-disabled={check.pending} onPress={() => void check.run()}>
          {button}
        </Button>
      </div>
      <div role="status">{check.pending ? <Trans id="admin.system.running">Running…</Trans> : children}</div>
      {check.failure ? (
        <ErrorPanel focusOnMount error={check.failure} {...changeCopy(check.failure)} />
      ) : null}
    </section>
  );
}

const FAILURES = {
  write_failed: <Trans id="admin.system.write_failed">Could not write to the storage</Trans>,
  read_failed: <Trans id="admin.system.read_failed">Could not read from the storage</Trans>,
  delete_failed: <Trans id="admin.system.delete_failed">Could not delete from the storage</Trans>,
  timeout: <Trans id="admin.system.timeout">Timed out</Trans>,
};

function StorageCheck() {
  const check = useCheck(storageSchema, "/api/v1/admin/storage/check", true);
  const { result } = check;
  return (
    <Section
      title={<Trans id="admin.system.storage">Storage</Trans>}
      intro={
        <Trans id="admin.system.storage_intro">Writes a small object, reads it back and deletes it.</Trans>
      }
      button={<Trans id="admin.system.storage_button">Check storage</Trans>}
      check={check}
    >
      {result ? (
        <>
          <p>
            <Trans id="admin.system.driver">Driver:</Trans> <DirText dir="ltr">{result.driver}</DirText>
          </p>
          {result.failure ? (
            <p>{FAILURES[result.failure]}</p>
          ) : (
            <p>
              <Trans id="admin.system.writable">Writable and readable</Trans>
            </p>
          )}
        </>
      ) : null}
    </Section>
  );
}

const STATES = {
  present: <Trans id="admin.system.present">present</Trans>,
  missing: <Trans id="admin.system.missing">missing</Trans>,
  unchecked: <Trans id="admin.system.unchecked">could not be checked</Trans>,
  not_checked: <Trans id="admin.system.not_checked">not checked (no selector)</Trans>,
};

function MailDomainCheck() {
  const check = useCheck(dnsSchema, "/api/v1/admin/mail/check", false);
  const { result } = check;
  return (
    <Section
      title={<Trans id="admin.system.domain">Sending domain</Trans>}
      intro={
        <Trans id="admin.system.domain_intro">Looks up the SPF, DMARC and DKIM records of the sender.</Trans>
      }
      button={<Trans id="admin.system.domain_button">Check mail domain</Trans>}
      check={check}
    >
      {result && result.domain === null ? (
        <Trans id="admin.system.no_sender">No mail sender is set, so there is no domain to check.</Trans>
      ) : null}
      {result?.domain ? (
        <ul>
          {result.records.map((record) => (
            <li key={record.kind}>
              {record.kind}: {STATES[record.state]}
              {record.name ? (
                <>
                  {" "}
                  (<DirText dir="ltr">{record.name}</DirText>)
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

function TestMessage() {
  const check = useCheck(queuedSchema, "/api/v1/admin/mail/test", true);
  return (
    <Section
      title={<Trans id="admin.system.test">Test message</Trans>}
      intro={<Trans id="admin.system.test_intro">Queues one test message to your own address.</Trans>}
      button={<Trans id="admin.system.test_button">Send test message</Trans>}
      check={check}
    >
      {check.result?.queued ? (
        <Trans id="admin.system.queued">
          Queued. Whether it left the installation shows only as the message arriving in your inbox.
        </Trans>
      ) : null}
    </Section>
  );
}

export function SystemPage() {
  return (
    <>
      <h1 className="font-heading text-2xl">
        <Trans id="admin.system.title">Mail and storage</Trans>
      </h1>
      <p className="max-w-prose text-text-muted">
        <Trans id="admin.system.intro">
          These checks change nothing, except that the test message queues one test message to your own
          address.
        </Trans>
      </p>
      <StorageCheck />
      <MailDomainCheck />
      <TestMessage />
      <section className="flex max-w-prose flex-col gap-3">
        <h2 className="font-heading text-xl">
          <Trans id="admin.system.backup">Backups</Trans>
        </h2>
        <p>
          <Trans id="admin.system.backup_note">
            Back up the database and the storage folder together: a backup of one without the other cannot be
            restored.
          </Trans>
        </p>
      </section>
    </>
  );
}
