// The user flows: every page, a new day, entries that are saved and reloaded, and offline use.
// The tests tagged @smoke also run against the deployed site; they only use the browser's storage.
import { expect, test } from "@playwright/test";
import { createToday, openApp, today, waitForServiceWorker } from "./helpers";

test("@smoke every page opens, and today's day file is created with its text", async ({ page }) => {
  await openApp(page);
  for (const tab of ["Viewer", "Reports", "Projects", "Settings", "Editor"]) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(page.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
  }

  await page.getByRole("tab", { name: "Viewer" }).click();
  await page.getByRole("button", { name: "Week", exact: true }).click();
  await expect(page.getByRole("button", { name: "Week", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Day", exact: true }).click();

  await page.getByRole("tab", { name: "Editor" }).click();
  const file = await createToday(page);
  expect(file).toBe(today().file);
  await expect(page.locator("#status")).toContainText(`Created ${file}`);

  await page.getByRole("button", { name: "Plain text", exact: true }).click();
  await expect(page.locator("#plain-text")).toHaveValue(`${today().header}\n- [ ] \n`);
});

test("@smoke three entries are computed, saved, and still there after a reload", async ({ page }) => {
  await openApp(page);
  const file = await createToday(page);
  const text = [
    today().header,
    "- [ ] 0900 standup, client-a",
    "- [ ] 1000 focus writing",
    "- [ ] 1130 lunch",
    "",
  ].join("\n");

  await page.getByRole("button", { name: "Plain text", exact: true }).click();
  await page.locator("#plain-text").fill(text);
  await expect(page.locator("#status")).toContainText("3 entries");

  await page.getByRole("button", { name: "Entries", exact: true }).click();
  const rows = page.locator("#entries table tbody tr");
  await expect(rows).toHaveCount(4); // the date line and the three entries
  await expect(rows.nth(1).locator("td").nth(1)).toHaveText("09:00");
  await expect(rows.nth(1).locator("td").nth(2)).toHaveText("10:00");
  await expect(rows.nth(2).locator("td").nth(2)).toHaveText("11:30");
  await expect(rows.nth(3).locator("td").nth(2)).toHaveText("open");

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#status")).toContainText("Saved");

  await page.goto(`./?name=${encodeURIComponent(file)}#editor`);
  await expect(page.locator("#editor-file")).toHaveValue(file);
  await page.getByRole("button", { name: "Plain text", exact: true }).click();
  await expect(page.locator("#plain-text")).toHaveValue(text);
});

test("@smoke after the first visit the app and the saved day load offline", async ({ page, context }) => {
  await openApp(page);
  await waitForServiceWorker(page);
  const file = await createToday(page);
  await page.getByRole("button", { name: "Plain text", exact: true }).click();
  await page.locator("#plain-text").fill(`${today().header}\n- [ ] 0900 offline check\n- [ ] 1000 end\n`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#status")).toContainText("Saved");

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("tab", { name: "Editor" })).toBeVisible();
  await expect(page.locator("#editor-file")).toHaveValue(file);
  await page.getByRole("button", { name: "Plain text", exact: true }).click();
  await expect(page.locator("#plain-text")).toHaveValue(`${today().header}\n- [ ] 0900 offline check\n- [ ] 1000 end\n`);
  await context.setOffline(false);
});
