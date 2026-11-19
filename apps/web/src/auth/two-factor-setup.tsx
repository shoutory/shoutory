import { Trans, useLingui } from "@lingui/react/macro";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Form } from "react-aria-components";
import { Link } from "react-router";
import { encode } from "uqr";
import { z } from "zod";
import { type ApiError, request } from "../http/client";
import { Button } from "../ui/button";
import { ErrorPanel } from "../ui/error-panel";
import { TextField } from "../ui/text-field";
import { authCopy } from "./auth-copy";
import { SubmitButton, useAction } from "./auth-frame";

const checked = z.object({ status: z.boolean() });
const confirmed = z.object({ user: z.object({ id: z.string() }) });

interface Qr {
  uri: string;
  secret: string;
}

// The address is an `otpauth://totp/` URL (zod's own check, which has already parsed it); one without a secret is not a
// setup answer.
const started = z
  .object({
    totpURI: z.url({ protocol: /^otpauth$/, hostname: /^totp$/ }).max(512),
    backupCodes: z.array(z.string().max(64)).max(20),
  })
  .transform((answer, ctx) => {
    const secret = new URL(answer.totpURI).searchParams.get("secret");
    if (secret) return { qr: { uri: answer.totpURI, secret }, codes: answer.backupCodes };
    ctx.addIssue({ code: "custom", message: "the setup answer holds no secret" });
    return z.NEVER;
  });

/** The QR of `text`, drawn here as one SVG path: the address holds the secret, so it never goes to a QR service. */
function QrImage({ text }: { text: string }) {
  const { t } = useLingui();
  const { size, path } = useMemo(() => {
    const matrix = encode(text, { border: 4 });
    const squares = matrix.data.flatMap((row, y) => row.map((dark, x) => (dark ? `M${x},${y}h1v1h-1z` : "")));
    return { size: matrix.size, path: squares.join("") };
  }, [text]);
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={t({ id: "auth.setup.qr_alt", message: "QR code for your authenticator app" })}
      shapeRendering="crispEdges"
      className="size-48 bg-white"
    >
      <path d={path} fill="black" />
    </svg>
  );
}

function CopyButton({ text, children }: { text: string; children: ReactNode }) {
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

// Each step names itself; a step after the first moves focus to its heading.
function StepHeading({ children, focus }: { children: ReactNode; focus: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) heading.current?.focus();
  }, [focus]);
  return (
    <h2 ref={heading} tabIndex={-1} className="font-heading text-xl">
      {children}
    </h2>
  );
}

// A refused password or code is emptied; a failure of the server or the network keeps it for another press.
const refused = (error: ApiError) =>
  error.code === "validation_failed" || error.code === "invalid_credentials";

function PasswordStep({ onStarted }: { onStarted: (qr: Qr, codes: string[]) => void }) {
  const { t } = useLingui();
  const [password, setPassword] = useState("");
  const start = useAction(
    async () => {
      const body = { password };
      await request(checked, "/api/auth/verify-password", { method: "POST", body, envelope: false });
      const answer = await request(started, "/api/auth/two-factor/enable", {
        method: "POST",
        body,
        envelope: false,
      });
      setPassword("");
      onStarted(answer.qr, answer.codes);
    },
    (error) => refused(error) && setPassword(""),
  );
  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault();
        void start.run();
      }}
      className="flex flex-col gap-5"
    >
      <StepHeading focus={false}>
        <Trans id="auth.setup.password_heading">Confirm your password</Trans>
      </StepHeading>
      <TextField
        label={t({ id: "auth.sign_in.password", message: "Password" })}
        name="password"
        type="password"
        autoComplete="current-password"
        isRequired
        value={password}
        onChange={setPassword}
      />
      <SubmitButton pending={start.pending} online={start.online}>
        <Trans id="auth.setup.continue">Continue</Trans>
      </SubmitButton>
      {start.failure ? (
        <ErrorPanel focusOnMount error={start.failure} {...authCopy("step-up", start.failure)} />
      ) : null}
    </Form>
  );
}

function QrStep({ qr, onConfirmed }: { qr: Qr; onConfirmed: () => void }) {
  const { t } = useLingui();
  const [code, setCode] = useState("");
  const confirm = useAction(
    async () => {
      // Authenticator apps group the digits with spaces; the server wants none.
      const body = { code: code.replaceAll(/\s/g, "") };
      await request(confirmed, "/api/auth/two-factor/verify-totp", { method: "POST", body, envelope: false });
      setCode("");
      onConfirmed();
    },
    (error) => refused(error) && setCode(""),
  );
  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault();
        void confirm.run();
      }}
      className="flex flex-col gap-5"
    >
      <StepHeading focus>
        <Trans id="auth.setup.qr_heading">Scan the code</Trans>
      </StepHeading>
      <p>
        <Trans id="auth.setup.qr_body">
          Scan this code with your authenticator app, or type the secret in by hand. Other devices were signed
          out when setup started.
        </Trans>
      </p>
      <QrImage text={qr.uri} />
      <p>
        <Trans id="auth.setup.secret_label">Secret for typing in by hand</Trans>
        <br />
        <code className="break-all" dir="ltr">
          {qr.secret}
        </code>
      </p>
      <CopyButton text={qr.secret}>
        <Trans id="auth.setup.copy_secret">Copy secret</Trans>
      </CopyButton>
      <TextField
        label={t({ id: "auth.mfa.code_label", message: "Authentication code" })}
        name="code"
        autoComplete="one-time-code"
        inputMode="numeric"
        isRequired
        value={code}
        onChange={setCode}
      />
      <SubmitButton pending={confirm.pending} online={confirm.online}>
        <Trans id="auth.setup.turn_on">Turn on</Trans>
      </SubmitButton>
      {confirm.failure ? (
        <ErrorPanel focusOnMount error={confirm.failure} {...authCopy("challenge", confirm.failure)} />
      ) : null}
    </Form>
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

function CodesStep({ codes, onSaved }: { codes: string[]; onSaved: () => void }) {
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

/**
 * A-04 setup (`/account/security/two-factor`): password, then the QR and secret with the first code, then the recovery
 * codes once. The secret and the codes live in this component's memory only, so leaving the page drops them.
 */
export function TwoFactorSetupPage() {
  const [qr, setQr] = useState<Qr | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  let step: ReactNode;
  if (done) {
    step = (
      <section className="flex flex-col gap-5">
        <StepHeading focus>
          <Trans id="auth.setup.done">Two-step verification is on</Trans>
        </StepHeading>
        <Link to="/" className="text-link underline">
          <Trans id="auth.setup.start">Go to the start page</Trans>
        </Link>
      </section>
    );
  } else if (codes) {
    step = (
      <CodesStep
        codes={codes}
        onSaved={() => {
          setCodes(null);
          setDone(true);
        }}
      />
    );
  } else if (qr) {
    step = (
      <QrStep
        qr={qr}
        onConfirmed={() => {
          setCodes(pending);
          setPending([]);
          setQr(null);
        }}
      />
    );
  } else {
    step = (
      <PasswordStep
        onStarted={(next, issued) => {
          setQr(next);
          setPending(issued);
        }}
      />
    );
  }
  return (
    <>
      <h1 className="font-heading text-2xl">
        <Trans id="auth.setup.title">Set up two-step verification</Trans>
      </h1>
      {step}
    </>
  );
}
