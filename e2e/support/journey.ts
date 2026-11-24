import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type Browser, expect, type Page } from "@playwright/test";
import { waitForLink } from "./mail";
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
  /** The person the first journey invited: a member of the workspace, not an administrator of the instance. */
  readonly member: Account;
}

/**
 * A person with an address and a password made for this run only. The tag is eight decimal digits, which the page's
 * font sets at one width each, so a name or address is as wide in every run and a table's columns do not move.
 */
export function newAccount(label: string): Account {
  const tag = Array.from(randomBytes(8), (byte) => byte % 10).join("");
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

export async function inviteMember(page: Page, workspaceId: string, email: string): Promise<void> {
  await page.goto(`/w/${workspaceId}/settings/members`);
  await field(page, "invite-open").click();
  await field(page, "invite-email").fill(email);
  await field(page, "invite-submit").click();
  await expect(field(page, "invite-email")).toBeHidden();
}

/** The file a member's facts are kept in; its time is when the member's last code was used (enrolment). */
export const memberStatePath = (label: string): string => `${STATE_DIR}/member-${label}.json`;

/**
 * A new person with the second factor on: `inviter` (a signed-in administrator's page) invites them to every
 * workspace, they sign up through the first invitation, accept each one (unless `accept` is false: the invitation stays
 * pending and the person has no workspace), and enrol. Ends signed out; the caller signs in as them, with the next
 * code of the returned secret.
 */
export async function createMember(options: {
  browser: Browser;
  inviter: Page;
  label: string;
  workspaces: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  accept?: boolean;
}): Promise<{ account: Account; secret: string }> {
  const account = newAccount(options.label);
  const context = await options.browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    const used: string[] = [];
    for (const [index, workspace] of options.workspaces.entries()) {
      await inviteMember(options.inviter, workspace.id, account.email);
      if (index === 0) {
        await signUp(page, account);
        await confirmEmail(page, await waitForLink({ to: account.email, path: "/auth/verify" }));
        await signIn(page, account);
      }
      if (options.accept === false) continue;
      used.push(await waitForLink({ to: account.email, path: "/invite/", skip: used }));
      await page.goto(used.at(-1) ?? "");
      await field(page, "invite-accept").click();
      await expect(field(page, "workspace-name")).toHaveText(workspace.name);
    }
    const made = { account, secret: await enrolTotp(page, account) };
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(memberStatePath(options.label), JSON.stringify(made));
    return made;
  } finally {
    // A step that fails must not leave the browser context open.
    await context.close();
  }
}

/** A member `createMember` made earlier in this run, by its label; later specs reuse it instead of signing up again. */
export function loadMember(label: string): { account: Account; secret: string } {
  const file = memberStatePath(label);
  if (!existsSync(file)) {
    throw new Error(`no member "${label}" was made: the founder project's specs make it, and they run first`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as { account: Account; secret: string };
}

export async function saveFounder(page: Page, founder: Founder): Promise<void> {
  mkdirSync(STATE_DIR, { recursive: true });
  await page.context().storageState({ path: FOUNDER_STATE });
  writeFileSync(FOUNDER_FACTS, JSON.stringify(founder));
}

export async function loadFounder(): Promise<Founder> {
  return JSON.parse(readFileSync(FOUNDER_FACTS, "utf8")) as Founder;
}
