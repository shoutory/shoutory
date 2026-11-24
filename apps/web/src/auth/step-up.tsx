import { Trans, useLingui } from "@lingui/react/macro";
import { createContext, type ReactNode, useContext, useRef, useState } from "react";
import { Form } from "react-aria-components";
import { useLocation, useNavigate } from "react-router";
import { z } from "zod";
import { ApiError, request } from "../http/client";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { ErrorPanel } from "../ui/error-panel";
import { TextField } from "../ui/text-field";
import { authCopy } from "./auth-copy";
import { SubmitButton, useAction } from "./auth-frame";

type StepUp = <T>(call: () => Promise<T>) => Promise<T>;
type Method = "password" | "totp";
const StepUpContext = createContext<StepUp | null>(null);

export function useStepUp(): StepUp {
  const stepUp = useContext(StepUpContext);
  if (!stepUp) throw new Error("useStepUp is used outside the StepUpProvider");
  return stepUp;
}

const verified = z.object({ status: z.boolean() });
const verifyPassword = (password: string) =>
  request(verified, "/api/auth/verify-password", { method: "POST", body: { password }, envelope: false });
// With a live session this route only records a new step-up; the answer carries the user.
const codeVerified = z.object({ user: z.object({ email: z.string() }) });
const verifyCode = (code: string, recovery: boolean) =>
  request(codeVerified, `/api/auth/two-factor/${recovery ? "verify-backup-code" : "verify-totp"}`, {
    method: "POST",
    body: { code: code.trim() },
    envelope: false,
  });

// A second refusal, a cancel and a failed check return the original refusal. Anything but a code means the password.
async function replayOnce<T>(
  call: () => Promise<T>,
  confirm: (method: Method) => Promise<boolean>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "step_up_required") throw error;
    if (!(await confirm(error.details?.method === "totp" ? "totp" : "password"))) throw error;
    return call();
  }
}

const StepUpTitle = ({ method }: { method: Method }) =>
  method === "totp" ? (
    <Trans id="auth.step_up.title_code">Enter your authentication code</Trans>
  ) : (
    <Trans id="auth.step_up.title">Confirm your password</Trans>
  );

type Proof = "password" | "code" | "recovery";
const proofOf = (method: Method, recovery: boolean): Proof =>
  method === "password" ? "password" : recovery ? "recovery" : "code";

function StepUpIntro({ proof }: { proof: Proof }) {
  if (proof === "password") {
    return <Trans id="auth.step_up.intro">This action needs your password again.</Trans>;
  }
  if (proof === "recovery") {
    return (
      <Trans id="auth.step_up.intro_recovery">
        This action needs one of your recovery codes. Each code works once.
      </Trans>
    );
  }
  return <Trans id="auth.step_up.intro_code">This action needs a code from your authenticator app.</Trans>;
}

function StepUpField({
  proof,
  value,
  onValue,
}: {
  proof: Proof;
  value: string;
  onValue: (value: string) => void;
}) {
  const { t } = useLingui();
  const fields = {
    password: {
      label: t({ id: "auth.step_up.password", message: "Password" }),
      name: "password",
      testId: "stepup-password",
      type: "password" as const,
      autoComplete: "current-password",
    },
    code: {
      label: t({ id: "auth.mfa.code_label", message: "Authentication code" }),
      name: "code",
      testId: "stepup-code",
      autoComplete: "one-time-code",
      inputMode: "numeric" as const,
      maxLength: 6,
    },
    recovery: {
      label: t({ id: "auth.mfa.recovery_label", message: "Recovery code" }),
      name: "code",
      testId: "stepup-code",
      autoComplete: "one-time-code",
      inputMode: "text" as const,
    },
  };
  return <TextField {...fields[proof]} isRequired value={value} onChange={onValue} />;
}

interface FormProps {
  method: Method;
  recovery: boolean;
  value: string;
  onValue: (value: string) => void;
  onToggleRecovery: () => void;
  check: ReturnType<typeof useAction>;
  onCancel: () => void;
}

function StepUpForm({ method, recovery, value, onValue, onToggleRecovery, check, onCancel }: FormProps) {
  const failure = check.failure;
  const code = method === "totp";
  const proof = proofOf(method, recovery);
  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault();
        void check.run();
      }}
      className="flex flex-col gap-5"
    >
      <p>
        <StepUpIntro proof={proof} />
      </p>
      <StepUpField proof={proof} value={value} onValue={onValue} />
      {code ? (
        <div>
          <Button aria-disabled={check.pending} onPress={onToggleRecovery}>
            {recovery ? (
              <Trans id="auth.mfa.use_code">Use an authenticator code</Trans>
            ) : (
              <Trans id="auth.mfa.use_recovery">Use a recovery code</Trans>
            )}
          </Button>
        </div>
      ) : null}
      {failure ? (
        <ErrorPanel focusOnMount error={failure} {...authCopy(code ? "step-up-code" : "step-up", failure)} />
      ) : null}
      <div className="flex flex-wrap gap-3">
        <SubmitButton testId="stepup-submit" pending={check.pending} online={check.online}>
          <Trans id="auth.step_up.confirm">Confirm</Trans>
        </SubmitButton>
        {/* While the check runs, cancel and dismiss are unavailable: the answer would arrive at a closed dialog. */}
        <Button aria-disabled={check.pending} onPress={onCancel}>
          <Trans id="auth.step_up.cancel">Cancel</Trans>
        </Button>
      </div>
    </Form>
  );
}

function StepUpDialog({ open, form }: { open: boolean; form: FormProps }) {
  return (
    <Dialog
      title={<StepUpTitle method={form.method} />}
      isOpen={open}
      onOpenChange={(next) => !next && !form.check.pending && form.onCancel()}
    >
      <StepUpForm {...form} />
    </Dialog>
  );
}

// A 401 `unauthenticated` while checking means the session is over: sign-in, which brings the person back afterwards.
// Every end of the dialog empties it, so no password, code or old error stays for the next time it opens.
export function StepUpProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<Method>("password");
  const [recovery, setRecovery] = useState(false);
  const [value, setValue] = useState("");
  const asking = useRef<Promise<boolean> | null>(null);
  const answer = useRef<(confirmed: boolean) => void>(() => undefined);
  function clear(next: boolean) {
    setValue("");
    setRecovery(next);
    check.reset();
  }
  function finish(confirmed: boolean) {
    clear(false);
    setOpen(false);
    asking.current = null;
    answer.current(confirmed);
  }
  const confirm = (asked: Method) => {
    asking.current ??= new Promise<boolean>((resolve) => {
      answer.current = resolve;
      setMethod(asked);
      setOpen(true);
    });
    return asking.current;
  };
  const check = useAction(
    async () => {
      await (method === "totp" ? verifyCode(value, recovery) : verifyPassword(value));
      finish(true);
    },
    (error) => {
      setValue("");
      if (error.state !== "session_expired") return;
      finish(false);
      void navigate(`/sign-in?return-to=${encodeURIComponent(location.pathname + location.search)}`);
    },
  );
  const stepUp: StepUp = (call) => replayOnce(call, confirm);
  return (
    <StepUpContext.Provider value={stepUp}>
      {children}
      <StepUpDialog
        open={open}
        form={{
          method,
          recovery,
          value,
          onValue: setValue,
          onToggleRecovery: () => clear(!recovery),
          check,
          onCancel: () => finish(false),
        }}
      />
    </StepUpContext.Provider>
  );
}
