import { Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { readZone } from "../../account/prefs";
import type { ApiError } from "../../http/client";
import { Banner } from "../../ui/banner";
import { Button } from "../../ui/button";
import { ErrorPanel } from "../../ui/error-panel";
import { LocalizedDateTime } from "../../ui/localized";
import type { Buffered, SaveState } from "./composer-save";

export function SaveIndicator({
  state,
  savedAt,
  online,
}: {
  state: SaveState;
  savedAt: Date | null;
  online: boolean;
}) {
  const shown = online ? state : "offline";
  // Only trouble and the end of it are announced; an ordinary save is not said aloud each time.
  const [trouble, setTrouble] = useState<"offline" | "paused" | null>(null);
  const [recovered, setRecovered] = useState(false);
  useEffect(() => {
    if (shown === "offline" || shown === "paused") {
      setTrouble(shown);
      setRecovered(false);
    } else if (shown === "saved" && trouble !== null) {
      setTrouble(null);
      setRecovered(true);
    }
  }, [shown, trouble]);
  return (
    <>
      <p data-testid="save-indicator" data-state={shown}>
        {shown === "offline" ? <Trans id="composer.save.offline">Not saved to the server</Trans> : null}
        {shown === "saving" ? <Trans id="composer.save.saving">Saving</Trans> : null}
        {shown === "unsaved" ? <Trans id="composer.save.unsaved">Unsaved changes</Trans> : null}
        {shown === "paused" ? (
          <Trans id="composer.save.paused">
            Saving paused for a moment. Your changes are kept on this device.
          </Trans>
        ) : null}
        {shown === "saved" && savedAt ? (
          <Trans id="composer.save.saved">
            Saved (<LocalizedDateTime value={savedAt} timeZone={readZone()} />)
          </Trans>
        ) : null}
      </p>
      <p role="status" data-testid="save-announce" className="sr-only">
        {trouble === "offline" ? <Trans id="composer.save.offline">Not saved to the server</Trans> : null}
        {trouble === "paused" ? (
          <Trans id="composer.save.paused">
            Saving paused for a moment. Your changes are kept on this device.
          </Trans>
        ) : null}
        {trouble === null && recovered ? (
          <Trans id="composer.save.recovered">Saved again. Your changes are on the server.</Trans>
        ) : null}
      </p>
    </>
  );
}

export function RestoreOffer({
  offer,
  onRestore,
  onDiscard,
}: {
  offer: Buffered | null;
  onRestore: () => void;
  onDiscard: () => void;
}) {
  if (offer === null) return null;
  const at = new Date(offer.at);
  return (
    <div data-testid="restore-offer">
      <Banner tone="info">
        <div className="flex flex-wrap items-center gap-3">
          <span>
            <Trans id="composer.restore.body">
              We found unsaved changes from <LocalizedDateTime value={at} timeZone={readZone()} />. Restore
              them?
            </Trans>
          </span>
          <Button data-testid="restore-yes" onPress={onRestore}>
            <Trans id="composer.restore.yes">Restore</Trans>
          </Button>
          <Button data-testid="restore-no" onPress={onDiscard}>
            <Trans id="composer.restore.no">Discard</Trans>
          </Button>
        </div>
      </Banner>
    </div>
  );
}

export function SaveFailure({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3" data-testid="save-failure">
      <ErrorPanel
        error={error}
        what={<Trans id="composer.save.failed.what">We could not save your changes</Trans>}
        meaning={
          <Trans id="composer.save.failed.meaning">
            Your changes are kept on this device. Try saving again.
          </Trans>
        }
      />
      <Button onPress={onRetry}>
        <Trans id="composer.save.retry">Save again</Trans>
      </Button>
    </div>
  );
}
