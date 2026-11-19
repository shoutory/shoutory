import { Trans } from "@lingui/react/macro";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";

/** A copy button: it says when the text was copied, or that the browser refused and the text is to be selected. */
export function CopyButton({ text, children }: { text: string; children: ReactNode }) {
  const [result, setResult] = useState<"copied" | "refused" | null>(null);
  if (!navigator.clipboard) return null;
  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => setResult("copied"),
      (error: unknown) => {
        // A refused clipboard permission is a normal answer: the text stays on the page to select by hand.
        if (!(error instanceof DOMException)) throw error;
        setResult("refused");
      },
    );
  };
  return (
    <span className="flex items-center gap-3">
      <Button onPress={copy}>{children}</Button>
      <span role="status">
        {result === "copied" ? <Trans id="auth.setup.copied">Copied</Trans> : null}
        {result === "refused" ? (
          <Trans id="auth.setup.copy_failed">Could not copy; select the text instead.</Trans>
        ) : null}
      </span>
    </span>
  );
}

/**
 * The heading of a step or block; with `focus` it takes focus when it appears, so a screen reader hears the change,
 * and again each time `refocus` changes (a block whose content changes under it more than once).
 */
export function StepHeading({
  children,
  focus,
  refocus = 0,
}: {
  children: ReactNode;
  focus: boolean;
  refocus?: number;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    void refocus;
    if (focus) heading.current?.focus();
  }, [focus, refocus]);
  return (
    <h2 ref={heading} tabIndex={-1} className="font-heading text-xl">
      {children}
    </h2>
  );
}

// A browser may read the Blob after the click returns, so its URL is revoked after this long or on leaving the codes.
const REVOKE_AFTER_MS = 40_000;

function useDownload(codes: string[]) {
  const urls = useRef(new Set<string>());
  useEffect(() => {
    const held = urls.current;
    return () => {
      for (const url of held) URL.revokeObjectURL(url);
      held.clear();
    };
  }, []);
  return () => {
    const url = URL.createObjectURL(new Blob([codes.join("\n")], { type: "text/plain" }));
    urls.current.add(url);
    const link = document.createElement("a");
    link.href = url;
    link.download = "shoutory-recovery-codes.txt";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => {
      if (urls.current.delete(url)) URL.revokeObjectURL(url);
    }, REVOKE_AFTER_MS);
  };
}

// The codes are shown once: closing or reloading the tab while they are on screen asks first.
function useLeaveGuard() {
  useEffect(() => {
    const ask = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, []);
}

/** Recovery codes shown once, with copy, download and a leave guard; `onSaved` ends the step and the codes go. */
export function CodesStep({ codes, onSaved }: { codes: string[]; onSaved: () => void }) {
  const download = useDownload(codes);
  useLeaveGuard();
  return (
    <section className="flex flex-col gap-5">
      <StepHeading focus>
        <Trans id="auth.setup.codes_heading">Save your recovery codes</Trans>
      </StepHeading>
      <p>
        <Trans id="auth.setup.codes_body">
          Each code works once if you lose your authenticator app. They are shown only now. This device stays
          signed in.
        </Trans>
      </p>
      <ul className="grid grid-cols-2 gap-2" dir="ltr">
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        <CopyButton text={codes.join("\n")}>
          <Trans id="auth.setup.copy_codes">Copy codes</Trans>
        </CopyButton>
        <Button onPress={download}>
          <Trans id="auth.setup.download">Download</Trans>
        </Button>
        <Button onPress={onSaved}>
          <Trans id="auth.setup.saved">I saved my codes</Trans>
        </Button>
      </div>
    </section>
  );
}
