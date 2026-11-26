import { readFile } from "node:fs/promises";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { createMember, loadFounder, memberHeaders, signIn } from "../support/journey";
import { newRecoveryCodes } from "../support/quality";
import { nextTotp } from "../support/totp";

// The Blob URL of a download may be read after the click returns, so it lives 40 seconds and goes when the codes do.
const REVOKE_AFTER_MS = 40_000;
type Blobs = { created: string[]; revoked: string[] };

const blobs = (page: Page) => page.evaluate(() => (window as unknown as { __blobs: Blobs }).__blobs);

async function download(page: Page): Promise<string> {
  const pending = page.waitForEvent("download");
  await page.getByTestId("codes-download").click();
  return readFile(await (await pending).path(), "utf8");
}

// A member of its own, so the founder's one-use code is not spent here while another shard uses it.
async function signedInMember(
  founderPage: Page,
  browser: Browser,
): Promise<{ page: Page; password: string; secret: string; close: () => Promise<void> }> {
  const founder = await loadFounder();
  const { account, secret } = await createMember({
    browser,
    inviter: founderPage,
    label: "download",
    workspaces: [founder.workspace],
    accept: false,
  });
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: memberHeaders("download"),
  });
  const page = await context.newPage();
  await signIn(page, account);
  await page.waitForURL(/\/mfa/);
  await page.getByTestId("mfa-code").fill(await nextTotp(secret));
  await page.getByTestId("mfa-submit").click();
  await expect(page.getByTestId("onboarding-create")).toBeVisible();
  return { page, password: account.password, secret, close: () => context.close() };
}

test("the recovery codes download holds the codes, and its Blob URL is revoked at 40 seconds and on leaving", async ({
  page: founderPage,
  browser,
}) => {
  const member = await signedInMember(founderPage, browser);
  const { page } = member;
  try {
    await page.addInitScript(() => {
      const seen: Blobs = { created: [], revoked: [] };
      (window as unknown as { __blobs: Blobs }).__blobs = seen;
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        const url = create(blob);
        seen.created.push(url);
        return url;
      };
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = (url) => {
        seen.revoked.push(url);
        revoke(url);
      };
    });
    // The member has just signed in with a code, so the identity check is fresh already.
    const codes = await newRecoveryCodes(page, member.password, member.secret, false);
    // From here the page's timers are ours and time stands still until `fastForward` moves it: the revoke timer is the
    // one the download starts, and nothing else can fire it.
    const start = Date.now();
    await page.clock.install({ time: start });
    await page.clock.pauseAt(start + 1_000);

    expect(await download(page)).toBe(codes.join("\n"));
    const { created } = await blobs(page);
    expect(created).toHaveLength(1);
    const [first] = created;
    await page.clock.fastForward(REVOKE_AFTER_MS - 1_000);
    expect((await blobs(page)).revoked).toEqual([]);
    await page.clock.fastForward(1_000);
    expect((await blobs(page)).revoked).toEqual([first]);

    await download(page);
    await page.getByTestId("recovery-saved").click();
    const seen = await blobs(page);
    expect(seen.revoked).toHaveLength(2);
    expect(seen.revoked).toEqual(seen.created);
  } finally {
    await member.close();
  }
});
