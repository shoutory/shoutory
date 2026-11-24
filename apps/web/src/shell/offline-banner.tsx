import { Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { Banner } from "../ui/banner";

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

export function OfflineBanner() {
  const online = useOnline();
  // The live region is always there, empty while online, so the text is announced when it arrives.
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
