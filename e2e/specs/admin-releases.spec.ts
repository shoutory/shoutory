import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// The root package.json is what the image ships beside the build; the stack builds the beta channel.
test("Z-07 shows the root package.json version and the beta channel to the founder", async ({ page }) => {
  const root = new URL("../../package.json", import.meta.url);
  const { version } = JSON.parse(readFileSync(root, "utf8")) as { version: string };
  await page.goto("/admin/releases");
  await expect(page.getByTestId("release-version")).toHaveText(version);
  await expect(page.getByTestId("release-channel")).toHaveAttribute("data-channel", "beta");
});
