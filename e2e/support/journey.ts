import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { STATE_DIR } from "./stack";
import { nextTotp } from "./totp";

/** The founder's browser session, saved by the journey that creates it and used by the specs that depend on it. */
export const FOUNDER_STATE = `${STATE_DIR}/founder-session.json`;
const FOUNDER_FACTS = `${STATE_DIR}/founder.json`;

export interface Account {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly tag: string;
}
export interface Founder {
  readonly account: Account;
  readonly secret: string;
  readonly workspace: { readonly id: string; readonly name: string };
}

/** A person with an address and a password made for this run only. */
export function newAccount(label: string): Account {
  const tag = randomBytes(4).toString("hex");
  return {
    name: `${label} ${tag}`,
    email: `${label}-${tag}@e2e.test`,
    password: randomBytes(18).toString("base64url"),
    tag,
  };
}

const field = (page: Page, id: string) => page.getByTestId(id);

export async function signUp(page: Page, account: Account): Promise<void> {
  await page.goto("/sign-up");
  await field(page, "sign-up-name").fill(account.name);
  await field(page, "sign-up-email").fill(account.email);
  await field(page, "sign-up-password").fill(account.password);
  await field(page, "sign-up-submit").click();
  await expect(field(page, "sign-up-sent")).toBeVisible();
}

/** Opens the mailed link and presses its one button. */
export async function confirmEmail(page: Page, link: string): Promise<void> {
  await page.goto(link);
  await field(page, "verify-confirm").click();
  await expect(field(page, "verify-done")).toBeVisible();
}

/** Submits the password form and waits until the page leaves the sign-in screen. */
export async function signIn(page: Page, account: Account): Promise<void> {
  await page.goto("/sign-in");
  await field(page, "sign-in-email").fill(account.email);
  await field(page, "sign-in-password").fill(account.password);
  await field(page, "sign-in-submit").click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));
}

/** Signs in and answers the second-factor challenge with a code from a step the server has not seen yet. */
export async function signInWithCode(page: Page, account: Account, secret: string): Promise<void> {
  await signIn(page, account);
  await page.waitForURL(/\/mfa/);
  await field(page, "mfa-code").fill(await nextTotp(secret));
  await field(page, "mfa-submit").click();
  await page.waitForURL(/\/w\//);
}

export const workspaceIdOf = (url: string): string => {
  const id = new URL(url).pathname.split("/")[2];
  if (!id) throw new Error(`no workspace id in ${url}`);
  return id;
};

/** The first organization and workspace of a person who has none; ends on the workspace. */
export async function createOrganization(
  page: Page,
  names: { organization: string; workspace: string },
): Promise<{ name: string }> {
  await page.goto("/");
  await field(page, "onboarding-organization").fill(names.organization);
  await field(page, "onboarding-workspace").fill(names.workspace);
  await field(page, "onboarding-create").click();
  await page.waitForURL(/\/w\//);
  return { name: names.workspace };
}

interface Listed {
  readonly data: ReadonlyArray<{ id: string; name: string; organization_id: string }>;
}

/** Adds a client (a workspace) to the signed-in person's organization and ends on it. */
export async function createClient(
  page: Page,
  name: string,
): Promise<{ id: string; name: string; organization: string }> {
  const mine = (await (await page.request.get("/api/v1/workspaces")).json()) as Listed;
  const organization = mine.data[0]?.organization_id;
  if (!organization) throw new Error("the signed-in person has no organization");
  await page.goto(`/o/${organization}/clients`);
  await field(page, "clients-add").click();
  await field(page, "clients-name").fill(name);
  await field(page, "clients-create").click();
  await expect(field(page, "clients-name")).toBeHidden();
  const after = (await (await page.request.get("/api/v1/workspaces")).json()) as Listed;
  const added = after.data.find((workspace) => workspace.name === name);
  if (!added) throw new Error("the new client is not in the workspace list");
  await page.goto(`/w/${added.id}`);
  return { id: added.id, name, organization };
}

/** The TOTP enrolment of the signed-in person; returns the secret the server showed as text. */
export async function enrolTotp(page: Page, account: Account): Promise<string> {
  await page.goto("/account/security/two-factor");
  await field(page, "setup-password").fill(account.password);
  await field(page, "setup-start").click();
  const secret = (await field(page, "setup-secret").textContent())?.trim();
  if (!secret) throw new Error("the setup screen showed no secret");
  await field(page, "setup-code").fill(await nextTotp(secret));
  await field(page, "setup-confirm").click();
  await field(page, "recovery-saved").click();
  await expect(field(page, "setup-done")).toBeVisible();
  return secret;
}

export async function saveFounder(page: Page, founder: Founder): Promise<void> {
  mkdirSync(STATE_DIR, { recursive: true });
  await page.context().storageState({ path: FOUNDER_STATE });
  writeFileSync(FOUNDER_FACTS, JSON.stringify(founder));
}

export async function loadFounder(): Promise<Founder> {
  return JSON.parse(readFileSync(FOUNDER_FACTS, "utf8")) as Founder;
}
