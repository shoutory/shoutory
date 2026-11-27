import { Trans, useLingui } from "@lingui/react/macro";
import { normalizeInstanceHost } from "@shoutory/core/connect/host";
import { useEffect, useRef, useState } from "react";
import { Form } from "react-aria-components";
import { z } from "zod";
import { ApiError, request } from "../../http/client";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { DirText } from "../../ui/dir-text";
import { ErrorPanel } from "../../ui/error-panel";
import { TextField } from "../../ui/text-field";
import { useSignIn } from "./channels-hub";
import { SecretStep } from "./connect-secret";
import { StartError, useStart } from "./connect-start";

const platformSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  lifecycle: z.string(),
  auth_kind: z.string(),
  connectable: z.boolean(),
  needs_instance_host: z.boolean(),
  needs_login_hint: z.boolean().default(false),
  needs_public_origin: z.boolean().default(false),
  secret_kind: z.enum(["bot_token", "webhook_url"]).nullable().default(null),
});
type Platform = z.infer<typeof platformSchema>;
const OAUTH = new Set(["oauth2", "oauth2_pkce"]);
// A platform is connected by authorizing, or by pasting the one secret it names.
const startable = (one: Platform) =>
  one.connectable && (OAUTH.has(one.auth_kind) || one.secret_kind !== null);
// Every step that asks for something before the connect starts.
const asksFirst = (one: Platform) =>
  one.needs_instance_host || one.needs_login_hint || one.needs_public_origin || one.secret_kind !== null;

type PlatformsState =
  | { status: "loading" }
  | { status: "failed"; error: ApiError }
  | { status: "ready"; platforms: Platform[] };

function usePlatforms(ws: string) {
  const [state, setState] = useState<PlatformsState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const expired = useSignIn();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry counter; `expired` follows the location.
  useEffect(() => {
    let live = true;
    request(z.array(platformSchema), `/api/v1/workspaces/${ws}/providers`).then(
      (platforms) => live && setState({ status: "ready", platforms }),
      (error: unknown) => {
        if (!(error instanceof ApiError)) throw error;
        if (!live) return;
        if (error.state === "session_expired") expired();
        else setState({ status: "failed", error });
      },
    );
    return () => {
      live = false;
    };
  }, [ws, attempt]);
  const retry = () => {
    setState({ status: "loading" });
    setAttempt((now) => now + 1);
  };
  return { state, retry };
}

function Tile(props: { platform: Platform; busy: boolean; returned: boolean; onStart: () => void }) {
  const { platform, busy, onStart } = props;
  // A plain name, so the messages' `{provider}` placeholder finds its value (a member expression would not).
  const provider = platform.display_name;
  return (
    <li
      data-testid="provider-tile"
      data-provider-id={platform.id}
      className="flex flex-col items-start gap-3 rounded-md border border-border px-5 py-4"
    >
      <span className="text-md font-medium">
        <DirText>{platform.display_name}</DirText>
        {platform.lifecycle === "beta" ? (
          <span data-testid="tile-beta" className="ms-3 text-sm text-text-muted">
            <Trans id="connect.wizard.beta">Beta</Trans>
          </span>
        ) : null}
      </span>
      <p className="text-sm">
        {platform.secret_kind === null ? (
          <Trans id="connect.wizard.tile">
            You will go to <DirText>{provider}</DirText> to allow Shoutory to publish and read this account.
            We never see your password.
          </Trans>
        ) : (
          <Trans id="connect.wizard.tile.secret">
            You will paste one secret from <DirText>{provider}</DirText>. Shoutory keeps it sealed and never
            shows it again.
          </Trans>
        )}
      </p>
      <Button
        data-testid="tile-start"
        data-provider-id={platform.id}
        busy={busy}
        // Back from the server step lands on the tile that opened it.
        autoFocus={props.returned}
        onPress={onStart}
      >
        <ProviderAction provider={provider} busy={busy} />
      </Button>
    </li>
  );
}

function ProviderAction({ provider, busy }: { provider: string; busy: boolean }) {
  return busy ? (
    <Trans id="connect.wizard.busy">
      Opening <DirText>{provider}</DirText>
    </Trans>
  ) : (
    <Trans id="connect.wizard.continue">
      Continue to <DirText>{provider}</DirText>
    </Trans>
  );
}

// The address is checked here with the server's own rules, so a mistyped one never leaves the page.
function HostStep(props: {
  platform: Platform;
  busy: boolean;
  onBack: () => void;
  onSubmit: (host: string) => void;
}) {
  const { t } = useLingui();
  const provider = props.platform.display_name;
  const [typed, setTyped] = useState("");
  const [invalid, setInvalid] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const bad = t({ id: "connect.wizard.host.invalid", message: "Type an address like social.example." });
  const submit = () => {
    const host = normalizeInstanceHost(typed);
    setInvalid(host === undefined);
    // Back on the field, a screen reader reads the error it now describes.
    if (host === undefined) field.current?.focus();
    else props.onSubmit(host);
  };
  return (
    <Form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p className="text-sm">
        <Trans id="connect.wizard.host.intro">
          Your <DirText>{provider}</DirText> account lives on a server you chose. Type that server's address.
        </Trans>
      </p>
      <TextField
        label={t({ id: "connect.wizard.host.label", message: "Server address, like social.example" })}
        testId="host-field"
        inputRef={field}
        autoFocus
        ltr
        autoComplete="url"
        value={typed}
        onChange={(value) => {
          setTyped(value);
          setInvalid(false);
        }}
        {...(invalid ? { errorMessage: bad } : {})}
      />
      <div className="flex flex-wrap gap-3">
        {/* Once the start is sent the browser leaves for the server, so Back would only seem to cancel it. */}
        <Button data-testid="host-back" aria-disabled={props.busy} onPress={props.onBack}>
          <Trans id="connect.wizard.host.back">Back</Trans>
        </Button>
        <Button data-testid="host-continue" type="submit" busy={props.busy}>
          <ProviderAction provider={provider} busy={props.busy} />
        </Button>
      </div>
    </Form>
  );
}

// The account the person types, Latin and read left to right; empty is refused at the field.
function LoginHintStep(props: {
  platform: Platform;
  busy: boolean;
  onBack: () => void;
  onSubmit: (hint: string) => void;
}) {
  const { t } = useLingui();
  const provider = props.platform.display_name;
  const [typed, setTyped] = useState("");
  const [invalid, setInvalid] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const bad = t({ id: "connect.wizard.hint.invalid", message: "Type the handle or ID of the account." });
  const submit = () => {
    const hint = typed.trim();
    setInvalid(hint === "");
    if (hint === "") field.current?.focus();
    else props.onSubmit(hint);
  };
  return (
    <Form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p className="text-sm">
        <Trans id="connect.wizard.hint.intro">
          Type the handle or ID of the <DirText>{provider}</DirText> account you want to connect.
        </Trans>
      </p>
      <TextField
        label={t({ id: "connect.wizard.hint.label", message: "Handle or ID, like name.example" })}
        testId="hint-field"
        inputRef={field}
        autoFocus
        ltr
        autoComplete="username"
        value={typed}
        onChange={(value) => {
          setTyped(value);
          setInvalid(false);
        }}
        {...(invalid ? { errorMessage: bad } : {})}
      />
      <div className="flex flex-wrap gap-3">
        <Button data-testid="hint-back" aria-disabled={props.busy} onPress={props.onBack}>
          <Trans id="connect.wizard.host.back">Back</Trans>
        </Button>
        <Button data-testid="hint-continue" type="submit" busy={props.busy}>
          <ProviderAction provider={provider} busy={props.busy} />
        </Button>
      </div>
    </Form>
  );
}

// Said instead of the step when the install cannot be reached over public https: the platform's server could not fetch
// what it needs from here.
function OriginNote({ platform, onBack }: { platform: Platform; onBack: () => void }) {
  const provider = platform.display_name;
  return (
    <div className="flex flex-col gap-3">
      <p data-testid="origin-explanation" role="note" className="text-sm">
        <Trans id="connect.wizard.origin">
          <DirText>{provider}</DirText> connects only to a Shoutory that anyone can reach over https, because
          it fetches this app's details from here. This install is not reachable that way. Ask the person who
          runs it to give it a public https address.
        </Trans>
      </p>
      <div>
        <Button data-testid="origin-back" onPress={onBack}>
          <Trans id="connect.wizard.host.back">Back</Trans>
        </Button>
      </div>
    </div>
  );
}

type Step = {
  platform: Platform;
  busy: boolean;
  onBack: () => void;
  begin: (extra: StartExtra) => void;
  ws: string;
  onDone: () => void;
};
type StartExtra = { instance_host?: string; login_hint?: string };

function StepOf({ platform, busy, onBack, begin, ws, onDone }: Step) {
  if (platform.needs_public_origin) return <OriginNote platform={platform} onBack={onBack} />;
  if (platform.secret_kind !== null) {
    return (
      <SecretStep
        ws={ws}
        platform={{ ...platform, secret_kind: platform.secret_kind }}
        onBack={onBack}
        onDone={onDone}
      />
    );
  }
  if (platform.needs_login_hint) {
    return (
      <LoginHintStep
        platform={platform}
        busy={busy}
        onBack={onBack}
        onSubmit={(hint) => begin({ login_hint: hint })}
      />
    );
  }
  return (
    <HostStep
      platform={platform}
      busy={busy}
      onBack={onBack}
      onSubmit={(host) => begin({ instance_host: host })}
    />
  );
}

function Tiles({ ws, platforms, onDone }: { ws: string; platforms: Platform[]; onDone: () => void }) {
  const { start, busy, failure, clear } = useStart(ws);
  const [pressed, setPressed] = useState<string | null>(null);
  const [asking, setAsking] = useState<Platform | null>(null);
  const back = () => {
    clear();
    setPressed(asking?.id ?? null);
    setAsking(null);
  };
  const begin = (platform: Platform, extra: StartExtra = {}) => {
    if (start(platform.id, extra)) setPressed(platform.id);
  };
  return (
    <>
      {asking === null ? (
        <ul className="flex flex-col gap-3">
          {platforms.map((platform) => (
            <Tile
              key={platform.id}
              platform={platform}
              busy={busy && pressed === platform.id}
              returned={pressed === platform.id}
              onStart={() => (asksFirst(platform) ? setAsking(platform) : begin(platform))}
            />
          ))}
        </ul>
      ) : (
        <StepOf
          ws={ws}
          platform={asking}
          busy={busy}
          onBack={back}
          begin={(extra) => begin(asking, extra)}
          onDone={onDone}
        />
      )}
      {failure === null ? null : <StartError failure={failure} testId="start-error" />}
    </>
  );
}

function Body({ ws, onDone }: { ws: string; onDone: () => void }) {
  const { state, retry } = usePlatforms(ws);
  if (state.status === "loading") {
    return (
      <div data-testid="wizard-state" data-state="loading" role="status" aria-busy="true">
        <Trans id="connect.wizard.loading">Loading the platforms</Trans>
      </div>
    );
  }
  if (state.status === "failed") {
    return (
      <div data-testid="wizard-state" data-state="failed" className="flex flex-col items-start gap-3">
        <ErrorPanel
          what={<Trans id="connect.wizard.failed.what">We could not load the platforms</Trans>}
          meaning={<Trans id="connect.wizard.failed.meaning">Nothing was changed. Try again.</Trans>}
          error={state.error}
        />
        <Button data-testid="wizard-retry" onPress={retry}>
          <Trans id="channels.hub.retry">Try again</Trans>
        </Button>
      </div>
    );
  }
  const ready = state.platforms.filter(startable);
  if (ready.length === 0) {
    return (
      <div data-testid="wizard-state" data-state="empty" className="flex flex-col gap-1">
        <p className="text-md font-medium">
          <Trans id="connect.wizard.empty.what">No platform can be connected yet</Trans>
        </p>
        <p className="text-sm">
          <Trans id="connect.wizard.empty.meaning">
            Ask the person who runs this Shoutory install to set one up.
          </Trans>
        </p>
      </div>
    );
  }
  return (
    <div data-testid="wizard-state" data-state="tiles" className="flex flex-col gap-3">
      <Tiles ws={ws} platforms={ready} onDone={onDone} />
    </div>
  );
}

export function ConnectWizard({
  ws,
  isOpen,
  onOpenChange,
  onConnected,
}: {
  ws: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}) {
  return (
    <Dialog
      title={<Trans id="connect.wizard.title">Connect a channel</Trans>}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
    >
      <p>
        <Trans id="connect.wizard.intro">Pick where you publish.</Trans>
      </p>
      <Body ws={ws} onDone={onConnected} />
      <div>
        <Button data-testid="wizard-cancel" onPress={() => onOpenChange(false)}>
          <Trans id="auth.step_up.cancel">Cancel</Trans>
        </Button>
      </div>
    </Dialog>
  );
}
