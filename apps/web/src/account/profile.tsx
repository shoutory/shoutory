import { Trans, useLingui } from "@lingui/react/macro";
import { type ReactNode, useState } from "react";
import { Form, Label, Radio, RadioGroup } from "react-aria-components";
import { useNavigate, useRevalidator, useRouteLoaderData } from "react-router";
import { z } from "zod";
import { authCopy } from "../auth/auth-copy";
import { SubmitButton, useAction } from "../auth/auth-frame";
import { request } from "../http/client";
import { activateLocale, applyLocale, type Digits, type Locale, storeLocale } from "../i18n/i18n";
import { SESSION_ROUTE_ID, type Session } from "../session/session";
import { ErrorPanel } from "../ui/error-panel";
import { LocalizedNumber } from "../ui/localized";
import { TextField } from "../ui/text-field";
import { readDigits, readTheme, setDigits, setTheme, type Theme } from "./prefs";

const MAX_NAME = 100;
const saved = z.object({ name: z.string() });

function NameForm({ current }: { current: string }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [name, setName] = useState(current);
  const [invalid, setInvalid] = useState(false);
  const [done, setDone] = useState(false);
  const save = useAction(
    async () => {
      const answer = await request(saved, "/api/auth/profile", {
        method: "POST",
        body: { name: name.trim() },
      });
      // The field shows what the server kept (trimmed).
      setName(answer.name);
      setDone(true);
      await revalidator.revalidate();
    },
    (error) => {
      if (error.state === "session_expired") void navigate("/sign-in?return-to=%2Faccount%2Fprofile");
    },
  );
  // The same unit as the server's limit: the length of the string.
  const length = name.trim().length;
  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault();
        setDone(false);
        const bad = length < 1 || length > MAX_NAME;
        setInvalid(bad);
        if (!bad) void save.run();
      }}
      className="flex flex-col gap-5"
    >
      <TextField
        label={t({ id: "account.profile.name", message: "Name" })}
        name="name"
        autoComplete="name"
        value={name}
        onChange={(value) => {
          setName(value);
          setDone(false);
        }}
        {...(invalid
          ? { errorMessage: t({ id: "account.profile.name_length", message: "Use 1 to 100 characters." }) }
          : {})}
      />
      <SubmitButton pending={save.pending} online={save.online}>
        <Trans id="account.profile.save">Save</Trans>
      </SubmitButton>
      <p role="status">{done ? <Trans id="account.profile.saved">Saved</Trans> : null}</p>
      {save.failure ? (
        <ErrorPanel focusOnMount error={save.failure} {...authCopy("link", save.failure)} />
      ) : null}
    </Form>
  );
}

function Choice({ value, children }: { value: string; children: ReactNode }) {
  return (
    <Radio value={value} className="flex min-h-6 pointer-coarse:min-h-11 items-center gap-3">
      {children}
    </Radio>
  );
}

function Choices({
  label,
  value,
  onChange,
  children,
}: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <RadioGroup value={value} onChange={onChange} className="flex flex-col gap-2">
      <Label className="text-sm font-medium">{label}</Label>
      {children}
    </RadioGroup>
  );
}

function useLanguage() {
  const { i18n } = useLingui();
  const [failed, setFailed] = useState(false);
  const locale: Locale = i18n.locale === "ar" ? "ar" : "en";
  function choose(next: string) {
    const chosen: Locale = next === "ar" ? "ar" : "en";
    setFailed(false);
    storeLocale(chosen);
    // Language and direction change at once; the page's words follow when the catalog has loaded.
    applyLocale(chosen);
    activateLocale(chosen).catch(() => {
      // The catalog did not load: the page keeps the language it had, and says so.
      storeLocale(locale);
      applyLocale(locale);
      setFailed(true);
    });
  }
  return { locale, failed, choose };
}

// These three stay in this browser and apply at once; the language also loads its catalog.
function Settings() {
  const { locale, failed, choose } = useLanguage();
  const [theme, setThemeState] = useState<Theme>(readTheme);
  const [digits, setDigitsState] = useState<Digits>(readDigits);
  return (
    <div className="flex flex-col gap-5">
      <Choices label={<Trans id="account.profile.language">Language</Trans>} value={locale} onChange={choose}>
        <Choice value="en">English</Choice>
        <Choice value="ar">العربية</Choice>
      </Choices>
      {failed ? (
        <p role="alert">
          <Trans id="account.profile.language_failed">
            Could not load that language. Your language was not changed.
          </Trans>
        </p>
      ) : null}
      <Choices
        label={<Trans id="account.profile.theme">Theme</Trans>}
        value={theme}
        onChange={(next) => {
          const chosen: Theme = next === "dark" || next === "light" ? next : "system";
          setThemeState(chosen);
          setTheme(chosen);
        }}
      >
        <Choice value="system">
          <Trans id="account.profile.theme_system">System</Trans>
        </Choice>
        <Choice value="light">
          <Trans id="account.profile.theme_light">Light</Trans>
        </Choice>
        <Choice value="dark">
          <Trans id="account.profile.theme_dark">Dark</Trans>
        </Choice>
      </Choices>
      <Choices
        label={<Trans id="account.profile.digits">Digits</Trans>}
        value={digits}
        onChange={(next) => {
          const chosen: Digits = next === "arab" ? "arab" : "latn";
          setDigitsState(chosen);
          setDigits(chosen);
        }}
      >
        <Choice value="latn">
          <Trans id="account.profile.digits_latin">Latin</Trans>
        </Choice>
        <Choice value="arab">
          <Trans id="account.profile.digits_arabic">Arabic-Indic</Trans>
        </Choice>
      </Choices>
      <p>
        <Trans id="account.profile.sample">Example:</Trans> <LocalizedNumber value={1234} />
      </p>
    </div>
  );
}

/** A-06 (`/account/profile`): the name is the server's; language, theme and digits stay in this browser. */
export function ProfilePage() {
  const session = useRouteLoaderData<Session>(SESSION_ROUTE_ID);
  return (
    <>
      <h1 className="font-heading text-2xl">
        <Trans id="account.profile.title">Profile</Trans>
      </h1>
      {session ? <NameForm current={session.user.name} /> : null}
      <Settings />
    </>
  );
}
