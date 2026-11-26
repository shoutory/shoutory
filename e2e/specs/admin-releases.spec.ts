import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// The root package.json is what the image ships beside the build; the stack builds the beta channel.
const root = new URL("../../package.json", import.meta.url);
const { version } = JSON.parse(readFileSync(root, "utf8")) as { version: string };

test("the releases screen shows the root package.json version and the beta channel to the founder", async ({
  page,
}) => {
  await page.goto("/admin/releases");
  await expect(page.getByTestId("release-version")).toHaveText(version);
  await expect(page.getByTestId("release-channel")).toHaveAttribute("data-channel", "beta");
});

test("the About page, signed out, shows the root package.json version and links the source tag of that version", async ({
  browser,
}) => {
  const guest = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await guest.newPage();
  await page.goto("/about");
  await expect(page.getByTestId("about-version")).toHaveText(version);
  await expect(page.getByTestId("about-source")).toHaveAttribute(
    "href",
    `https://github.com/shoutory/shoutory/tree/v${version}`,
  );
  await guest.close();
});
