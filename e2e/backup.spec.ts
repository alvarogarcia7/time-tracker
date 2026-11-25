// Settings, the token, and the export and import of the browser's files.
import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { createToday, openApp } from "./helpers";

test("settings keep the owner and the repository, and the token can be forgotten", async ({ page }) => {
  await openApp(page);
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.locator("#set-owner").fill("example-owner");
  await page.locator("#set-token").fill("test-token-not-real");
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(page.locator("#set-status")).toHaveText("Settings saved on this device.");
  await expect(page.locator("#set-token")).toHaveAttribute("placeholder", "a token is saved on this device");
  await expect(page.locator("#set-token")).toHaveValue("");

  await page.reload();
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.locator("#set-owner")).toHaveValue("example-owner");
  await expect(page.locator("#set-repo")).toHaveValue("time-tracker-data");
  await expect(page.locator("#set-token")).toHaveAttribute("placeholder", "a token is saved on this device");

  await page.getByRole("button", { name: "Forget token", exact: true }).click();
  await expect(page.locator("#set-status")).toContainText("forgotten");
  await expect(page.locator("#set-token")).toHaveAttribute("placeholder", "paste the token");
});

test("sync without a token says that it is off", async ({ page }) => {
  await openApp(page);
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(page.locator("#set-status")).toContainText("Sync is off");
});

test("an export is one JSON file, importing it again changes nothing, and a changed file becomes a copy", async ({
  page,
}, testInfo) => {
  await openApp(page);
  const file = await createToday(page);
  await page.getByRole("tab", { name: "Settings" }).click();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export backup", exact: true }).click(),
  ]);
  const exported = await download.path();
  const bundle = JSON.parse(readFileSync(exported, "utf-8"));
  expect(bundle.format).toBe("time-parser-bundle");
  expect(bundle.days.map((day: { name: string }) => day.name)).toContain(file);

  await page.locator("#import-file").setInputFiles(exported);
  await expect(page.locator("#backup-status")).toContainText("Imported 0 new, 2 unchanged.");

  const changed = structuredClone(bundle);
  const day = changed.days.find((item: { name: string }) => item.name === file);
  day.text = `${day.text}- [ ] 0900 imported text\n`;
  const copyPath = testInfo.outputPath("changed-backup.json");
  writeFileSync(copyPath, JSON.stringify(changed));
  await page.locator("#import-file").setInputFiles(copyPath);
  await expect(page.locator("#backup-status")).toContainText(".conflict-");

  await page.getByRole("tab", { name: "Editor" }).click();
  await expect(page.locator("#editor-file")).toHaveValue(file);
  await page.locator("#editor-file").click();
  await expect(page.locator("#editor-file")).toHaveValue(file);
  await expect(page.locator("#file-list li", { hasText: ".conflict-" })).toHaveCount(1);
});
