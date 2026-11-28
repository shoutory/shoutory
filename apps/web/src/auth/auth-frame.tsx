import { Trans, useLingui } from "@lingui/react/macro";
import { type ReactNode, type Ref, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ApiError } from "../http/client";
import { useOnline } from "../shell/offline-banner";
import { Button } from "../ui/button";

// When `step` changes, focus moves to the heading, so a screen reader is told the page changed.
export function AuthFrame({
  title,
  step,
  children,
}: {
  title: ReactNode;
  step?: string;
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = useRef(step);
  useEffect(() => {
    if (shown.current === step) return;
    shown.current = step;
    heading.current?.focus();
  }, [step]);
  return (
    <main id="main" className="mx-auto flex w-full max-w-md flex-col gap-5 px-5 py-10">
      <span translate="no" className="font-heading text-lg">
        Shoutory
      </span>
      <h1 ref={heading} tabIndex={-1} className="font-heading text-2xl">
        {title}
      </h1>
      {children}
      <Link to="/about" className="min-h-6 pointer-coarse:min-h-11 self-start text-link underline">
        <Trans id="system.about.link">About Shoutory</Trans>
      </Link>
    </main>
  );
}

export function BadLink({ action }: { action: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-heading text-xl">
        <Trans id="auth.bad_link.what">This link cannot be used</Trans>
      </h2>
      <p>
        <Trans id="auth.bad_link.meaning">
          It may have expired or been used already. We can send a new one.
        </Trans>
      </p>
      {action}
    </section>
  );
}

// One thing at a time under a name: a press while another runs is ignored (Enter in a field submits even when the
// button is aria-disabled), and the refusal of the last one is kept to be shown.
export function useActions(onFailure?: (error: ApiError) => void) {
  const running = useRef(false);
  const online = useOnline();
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  async function run(name: string, act: () => Promise<void>) {
    if (running.current || !online) return;
    running.current = true;
    setBusy(name);
    setFailure(null);
    try {
      await act();
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      onFailure?.(error);
      setFailure(error);
    } finally {
      running.current = false;
      setBusy(null);
    }
  }
  return { run, busy, failure, online, reset: () => setFailure(null) };
}

// The same for a form or a button that does one thing.
export function useAction(act: () => Promise<void>, onFailure?: (error: ApiError) => void) {
  const actions = useActions(onFailure);
  return {
    run: () => actions.run("action", act),
    pending: actions.busy !== null,
    failure: actions.failure,
    online: actions.online,
    reset: actions.reset,
  };
}

export function SubmitButton({
  pending,
  online,
  children,
  ref,
  testId,
}: {
  pending: boolean;
  online: boolean;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
  testId?: string;
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
      {...(testId ? { "data-testid": testId } : {})}
    >
      {children}
    </Button>
  );
}
