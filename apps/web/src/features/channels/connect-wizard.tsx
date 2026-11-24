import { Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { z } from "zod";
import { ApiError, request } from "../../http/client";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { DirText } from "../../ui/dir-text";
import { ErrorPanel } from "../../ui/error-panel";
import { useSignIn } from "./channels-hub";
import { StartError, useStart } from "./connect-start";

const platformSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  lifecycle: z.string(),
  auth_kind: z.string(),
  connectable: z.boolean(),
});
type Platform = z.infer<typeof platformSchema>;
const OAUTH = new Set(["oauth2", "oauth2_pkce"]);

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

function Tile({ platform, busy, onStart }: { platform: Platform; busy: boolean; onStart: () => void }) {
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
        <Trans id="connect.wizard.tile">
          You will go to <DirText>{provider}</DirText> to allow Shoutory to publish and read this account. We
          never see your password.
        </Trans>
      </p>
      <Button data-testid="tile-start" data-provider-id={platform.id} busy={busy} onPress={onStart}>
        {busy ? (
          <Trans id="connect.wizard.busy">
            Opening <DirText>{provider}</DirText>
          </Trans>
        ) : (
          <Trans id="connect.wizard.continue">
            Continue to <DirText>{provider}</DirText>
          </Trans>
        )}
      </Button>
    </li>
  );
}

function Tiles({ ws, platforms }: { ws: string; platforms: Platform[] }) {
  const { start, busy, failure } = useStart(ws);
  const [pressed, setPressed] = useState<string | null>(null);
  return (
    <>
      <ul className="flex flex-col gap-3">
        {platforms.map((platform) => (
          <Tile
            key={platform.id}
            platform={platform}
            busy={busy && pressed === platform.id}
            onStart={() => {
              if (start(platform.id)) setPressed(platform.id);
            }}
          />
        ))}
      </ul>
      {failure === null ? null : <StartError failure={failure} testId="start-error" />}
    </>
  );
}

function Body({ ws }: { ws: string }) {
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
  const startable = state.platforms.filter((one) => one.connectable && OAUTH.has(one.auth_kind));
  if (startable.length === 0) {
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
      <Tiles ws={ws} platforms={startable} />
    </div>
  );
}

export function ConnectWizard({
  ws,
  isOpen,
  onOpenChange,
}: {
  ws: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
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
      <Body ws={ws} />
      <div>
        <Button data-testid="wizard-cancel" onPress={() => onOpenChange(false)}>
          <Trans id="auth.step_up.cancel">Cancel</Trans>
        </Button>
      </div>
    </Dialog>
  );
}
