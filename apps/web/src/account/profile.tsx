import { Trans, useLingui } from "@lingui/react/macro";
import { useRef, useState } from "react";
import { FileTrigger, Form } from "react-aria-components";
import { useNavigate, useRevalidator, useRouteLoaderData } from "react-router";
import { z } from "zod";
import { authCopy, type Words } from "../auth/auth-copy";
import { SubmitButton, useAction } from "../auth/auth-frame";
import { type ApiError, request } from "../http/client";
import { activateLocale, applyLocale, type Digits, type Locale, storeLocale } from "../i18n/i18n";
import { SESSION_ROUTE_ID, type Session } from "../session/session";
import { useChange } from "../settings/member-actions";
import { initialOf } from "../settings/workspace-avatar";
import { Button } from "../ui/button";
import { Choice, Choices } from "../ui/choices";
import { ErrorPanel } from "../ui/error-panel";
import { LocalizedNumber } from "../ui/localized";
import { TextField } from "../ui/text-field";
import { ZonePicker } from "../zones/zone-picker";
import { readDigits, readTheme, readZone, setDigits, setTheme, setZone, type Theme } from "./prefs";

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

function useLanguage() {
  const { i18n } = useLingui();
  const [failed, setFailed] = useState(false);
  const locale: Locale = i18n.locale === "ar" ? "ar" : "en";
  function choose(next: string) {
    const chosen: Locale = next === "ar" ? "ar" : "en";
    setFailed(false);
    storeLocale(chosen);
    applyLocale(chosen);
    activateLocale(chosen).catch(() => {
      storeLocale(locale);
      applyLocale(locale);
      setFailed(true);
    });
  }
  return { locale, failed, choose };
}

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

function ZoneField() {
  const { t } = useLingui();
  const [zone, setZoneState] = useState(readZone);
  return (
    <ZonePicker
      label={t({ id: "account.profile.zone", message: "Time zone" })}
      value={zone}
      onChange={(next) => {
        setZoneState(next);
        setZone(next);
      }}
    />
  );
}

const PICTURE = "/api/v1/me/avatar";
const PICTURE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_PICTURE_BYTES = 10 * 1024 * 1024;
// A 10 MB file on a slow link needs longer than an ordinary call.
const PICTURE_TIMEOUT_MS = 120_000;
const pictureSaved = z.object({ avatar_at: z.string() });

type PictureRefusal = "too_large" | "unsupported_type" | "corrupt" | "pixel_limit" | "offline";
const UNUSABLE: Words = {
  what: <Trans id="account.picture.unusable.what">That file cannot be used as a picture</Trans>,
  meaning: (
    <Trans id="account.picture.unusable.meaning">
      Choose a JPEG, PNG or WebP image. Your picture was not changed.
    </Trans>
  ),
};
const PICTURE_COPY: Record<PictureRefusal, Words> = {
  too_large: {
    what: <Trans id="account.picture.too_large.what">That file is too large</Trans>,
    meaning: (
      <Trans id="account.picture.too_large.meaning">
        Choose an image of 10 MB or less. Your picture was not changed.
      </Trans>
    ),
  },
  pixel_limit: {
    what: <Trans id="account.picture.pixels.what">That image is too big to read</Trans>,
    meaning: (
      <Trans id="account.picture.pixels.meaning">
        Choose a smaller image, under 50 megapixels. Your picture was not changed.
      </Trans>
    ),
  },
  offline: {
    what: <Trans id="account.picture.offline.what">You are offline</Trans>,
    meaning: (
      <Trans id="account.picture.offline.meaning">
        Nothing was sent. Choose the picture again when you are back online.
      </Trans>
    ),
  },
  unsupported_type: UNUSABLE,
  corrupt: UNUSABLE,
};

function pictureCopy(error: ApiError): Words {
  const reason = error.code === "payload_too_large" ? "too_large" : (error.details?.reason ?? "");
  return Object.hasOwn(PICTURE_COPY, reason)
    ? PICTURE_COPY[reason as PictureRefusal]
    : authCopy("link", error);
}

/** The person's picture, or the first letter of their name when there is none or it cannot be shown. */
function Picture({ name, at }: { name: string; at: string | null }) {
  const [broken, setBroken] = useState<string | null>(null);
  return (
    <span
      aria-hidden="true"
      data-testid="profile-picture"
      className="inline-flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-sunken text-xl font-medium"
    >
      {at && broken !== at ? (
        <img
          src={`${PICTURE}?v=${encodeURIComponent(at)}`}
          alt=""
          width={64}
          height={64}
          className="size-full object-cover"
          onError={() => setBroken(at)}
        />
      ) : (
        initialOf(name)
      )}
    </span>
  );
}

type Outcome = "saved" | "removed";

function usePictureSave(onRemoved: () => void) {
  const revalidator = useRevalidator();
  const chosen = useRef<File | null>(null);
  const [done, setDone] = useState<Outcome | null>(null);
  const save = useChange(async () => {
    const file = chosen.current;
    if (file)
      await request(pictureSaved, PICTURE, { method: "PUT", body: file, timeoutMs: PICTURE_TIMEOUT_MS });
    else await request(z.undefined(), PICTURE, { method: "DELETE", envelope: false });
    await revalidator.revalidate();
    setDone(file ? "saved" : "removed");
    if (!file) onRemoved();
  });
  const send = (file: File | null) => {
    chosen.current = file;
    setDone(null);
    void save.run();
  };
  return { ...save, send, done, uploading: save.pending && chosen.current !== null };
}

// The file dialog opens even from a button marked unavailable, so a pick made offline or during a save is refused here.
function refusalOf(file: File, online: boolean, pending: boolean): PictureRefusal | "busy" | null {
  if (pending) return "busy";
  if (!online) return "offline";
  if (file.size > MAX_PICTURE_BYTES) return "too_large";
  return PICTURE_TYPES.includes(file.type) ? null : "unsupported_type";
}

function Status({ uploading, done }: { uploading: boolean; done: Outcome | null }) {
  return (
    <p role="status" className="text-sm">
      {uploading ? <Trans id="account.picture.saving">Saving picture</Trans> : null}
      {done === "saved" ? <Trans id="account.picture.saved">Picture saved</Trans> : null}
      {done === "removed" ? <Trans id="account.picture.removed">Picture removed</Trans> : null}
    </p>
  );
}

function PictureField({ name, at }: { name: string; at: string | null }) {
  const { t } = useLingui();
  const chooser = useRef<HTMLButtonElement | null>(null);
  const [local, setLocal] = useState<PictureRefusal | null>(null);
  const save = usePictureSave(() => chooser.current?.focus());
  const choose = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    const refused = refusalOf(file, save.online, save.pending);
    if (refused === "busy") return;
    save.reset();
    setLocal(refused);
    if (!refused) save.send(file);
  };
  const offline = save.online
    ? {}
    : { reason: t({ id: "auth.offline", message: "You are offline. This needs the server." }) };
  const words = local ? PICTURE_COPY[local] : save.failure ? pictureCopy(save.failure) : null;
  return (
    <section className="flex flex-col items-start gap-3">
      <h2 className="text-sm font-medium">
        <Trans id="account.picture.title">Picture</Trans>
      </h2>
      <Picture name={name} at={at} />
      <div className="flex flex-wrap gap-3">
        <FileTrigger acceptedFileTypes={PICTURE_TYPES} onSelect={choose}>
          <Button
            ref={chooser}
            data-testid="picture-choose"
            busy={save.uploading}
            aria-disabled={save.pending || !save.online}
            {...offline}
          >
            <Trans id="account.picture.choose">Choose picture</Trans>
          </Button>
        </FileTrigger>
        {at ? (
          <Button
            data-testid="picture-remove"
            busy={save.pending && !save.uploading}
            aria-disabled={save.pending || !save.online}
            onPress={() => {
              setLocal(null);
              save.send(null);
            }}
          >
            <Trans id="account.picture.remove">Remove picture</Trans>
          </Button>
        ) : null}
      </div>
      <Status uploading={save.uploading} done={save.done} />
      {words ? (
        <ErrorPanel focusOnMount {...(local || !save.failure ? {} : { error: save.failure })} {...words} />
      ) : null}
    </section>
  );
}

export function ProfilePage() {
  const session = useRouteLoaderData<Session>(SESSION_ROUTE_ID);
  return (
    <>
      <h1 className="font-heading text-2xl">
        <Trans id="account.profile.title">Profile</Trans>
      </h1>
      {session ? <PictureField name={session.user.name} at={session.user.avatarAt} /> : null}
      {session ? <NameForm current={session.user.name} /> : null}
      <Settings />
      <ZoneField />
    </>
  );
}
