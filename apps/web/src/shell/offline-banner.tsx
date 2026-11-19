import { Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { Banner } from "../ui/banner";

/** Whether the browser is online: `navigator.onLine` at the start, then the window's `online` and `offline` events. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

/** The persistent banner of the offline state (ux-spec 2.1 O); nothing while online. */
export function OfflineBanner() {
  const online = useOnline();
  // The live region is always there, empty while online, so the text is announced when it arrives (WI-F13).
  return (
    <div role="status">
      {online ? null : (
        <Banner tone="attention" announce={false}>
          <Trans id="shell.offline.banner">
            You are offline. Changes you make here are not saved to the server yet.
          </Trans>
        </Banner>
      )}
    </div>
  );
}
