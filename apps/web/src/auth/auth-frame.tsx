import { useLingui } from "@lingui/react/macro";
import { type ReactNode, type Ref, useRef, useState } from "react";
import { ApiError } from "../http/client";
import { useOnline } from "../shell/offline-banner";
import { Button } from "../ui/button";

/** The page of an auth screen (ux-spec X-04's neighbours A-01..A-04): the brand, one heading, the form. */
export function AuthFrame({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <main id="main" className="mx-auto flex w-full max-w-md flex-col gap-5 px-5 py-10">
      <span translate="no" className="font-heading text-lg">
        Shoutory
      </span>
      <h1 className="font-heading text-2xl">{title}</h1>
      {children}
    </main>
  );
}

/**
 * One submit of a form or an action: it ignores a second press while it runs (Enter in a field submits even when the
 * button is aria-disabled) and while the browser is offline, and a failure of the server is the screen's to show.
 */
export function useAction(act: () => Promise<void>, onFailure?: (error: ApiError) => void) {
  const running = useRef(false);
  const online = useOnline();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  async function run() {
    if (running.current || !online) return;
    running.current = true;
    setPending(true);
    setFailure(null);
    try {
      await act();
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      onFailure?.(error);
      setFailure(error);
    } finally {
      running.current = false;
      setPending(false);
    }
  }
  return { run, pending, failure, online, reset: () => setFailure(null) };
}

/** The submit button: busy while it runs, aria-disabled with its reason while it cannot (NFR-A11Y-05). */
export function SubmitButton({
  pending,
  online,
  children,
  ref,
}: {
  pending: boolean;
  online: boolean;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}) {
  const { t } = useLingui();
  const reason = t({ id: "auth.offline", message: "You are offline. This needs the server." });
  return (
    <Button
      type="submit"
      busy={pending}
      aria-disabled={pending || !online}
      {...(online ? {} : { reason })}
      {...(ref ? { ref } : {})}
    >
      {children}
    </Button>
  );
}
