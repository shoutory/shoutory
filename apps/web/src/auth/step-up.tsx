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
/** What the server asks for: the password, or a code of the authenticator app when the account has the second factor. */
type Method = "password" | "totp";
const StepUpContext = createContext<StepUp | null>(null);

/** Runs a sensitive call; a 403 `step_up_required` asks for the password or a code once and replays the call once (X-04). */
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
const verifyCode = (code: string) =>
  request(codeVerified, "/api/auth/two-factor/verify-totp", {
    method: "POST",
    body: { code: code.trim() },
    envelope: false,
  });

// A refused call asks once and runs once more; a second refusal, a cancel and a failed check return the original
// refusal. The refusal says which proof the account needs; anything but a code means the password.
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

function StepUpForm({
  method,
  value,
  onValue,
  check,
  onCancel,
}: {
  method: Method;
  value: string;
  onValue: (value: string) => void;
  check: ReturnType<typeof useAction>;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const failure = check.failure;
  const code = method === "totp";
  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault();
        void check.run();
      }}
      className="flex flex-col gap-5"
    >
      <p>
        {code ? (
          <Trans id="auth.step_up.intro_code">This action needs a code from your authenticator app.</Trans>
        ) : (
          <Trans id="auth.step_up.intro">This action needs your password again.</Trans>
        )}
      </p>
      <TextField
        label={
          code
            ? t({ id: "auth.mfa.code_label", message: "Authentication code" })
            : t({ id: "auth.step_up.password", message: "Password" })
        }
        name={code ? "code" : "password"}
        testId={code ? "stepup-code" : "stepup-password"}
        {...(code
          ? { autoComplete: "one-time-code", inputMode: "numeric" as const, maxLength: 6 }
          : { type: "password", autoComplete: "current-password" })}
        isRequired
        value={value}
        onChange={onValue}
      />
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

/**
 * X-04: one dialog serves every call that needs a recent identity check, however many are refused together. A call
 * is replayed once after the check; a second refusal, a cancel and a failed check return the original refusal and
 * retry nothing. A 401 `unauthenticated` while checking means the session is over: sign-in.
 */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<Method>("password");
  const [value, setValue] = useState("");
  const asking = useRef<Promise<boolean> | null>(null);
  const answer = useRef<(confirmed: boolean) => void>(() => undefined);

  // Every end of the dialog empties it: no password or code and no old error stay for the next time it opens.
  function finish(confirmed: boolean) {
    setValue("");
    check.reset();
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
      await (method === "totp" ? verifyCode(value) : verifyPassword(value));
      finish(true);
    },
    (error) => {
      setValue("");
      if (error.state !== "session_expired") return;
      finish(false);
      // Signing in again brings the person back to where they were (checked by safeReturnTo at the end).
      void navigate(`/sign-in?return-to=${encodeURIComponent(location.pathname + location.search)}`);
    },
  );

  const stepUp: StepUp = (call) => replayOnce(call, confirm);

  return (
    <StepUpContext.Provider value={stepUp}>
      {children}
      <Dialog
        title={<StepUpTitle method={method} />}
        isOpen={open}
        onOpenChange={(next) => !next && !check.pending && finish(false)}
      >
        <StepUpForm
          method={method}
          value={value}
          onValue={setValue}
          check={check}
          onCancel={() => finish(false)}
        />
      </Dialog>
    </StepUpContext.Provider>
  );
}
