import { expect, test } from "@playwright/test";
import { createClient } from "../support/journey";

const MARKUP = "<script>window.__x=1</script>";

test("a workspace named <script>window.__x=1</script> shows as text and window.__x is undefined", async ({
  page,
}) => {
  const workspace = await createClient(page, MARKUP);
  const noMarkup = async () => {
    expect(await page.evaluate(() => (window as unknown as { __x?: unknown }).__x)).toBeUndefined();
    await expect(page.locator("script", { hasText: "__x" })).toHaveCount(0);
  };

  await expect(page.getByTestId("workspace-name")).toHaveText(MARKUP);
  await expect(page.getByTestId("switcher-workspace")).toHaveValue(MARKUP);
  await noMarkup();

  await page.goto(`/o/${workspace.organization}/clients`);
  await expect(page.getByRole("link", { name: MARKUP, exact: true })).toBeVisible();
  await noMarkup();
});
