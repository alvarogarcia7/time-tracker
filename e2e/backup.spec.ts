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

test("a conflict copy of the project database is listed in Settings, exported, and can be deleted", async ({ page }, testInfo) => {
  const databaseBackup = (projects: string) =>
    JSON.stringify({
      format: "time-parser-bundle",
      version: 1,
      exported: new Date().toISOString(),
      days: [],
      projects: { name: "projects.yml", text: projects, updated: new Date().toISOString() },
    });
  await openApp(page);
  await page.getByRole("tab", { name: "Settings" }).click();
  // The first import replaces the empty database this device starts with.
  const first = testInfo.outputPath("first-projects.json");
  writeFileSync(first, databaseBackup("sample-a:\n  keywords: [alpha]\n"));
  await page.locator("#import-file").setInputFiles(first);
  await expect(page.locator("#backup-status")).toContainText("Imported 1 new");
  // The second one differs from the database now on the device: it is kept as a copy.
  const second = testInfo.outputPath("second-projects.json");
  writeFileSync(second, databaseBackup("sample-b:\n  keywords: [beta]\n"));
  await page.locator("#import-file").setInputFiles(second);
  await expect(page.locator("#backup-status")).toContainText("saved as projects.conflict-");

  const listed = page.locator("#copies-list li");
  await expect(listed).toHaveCount(1);
  await expect(listed.first()).toContainText("projects.conflict-");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export backup", exact: true }).click(),
  ]);
  const exported = JSON.parse(readFileSync(await download.path(), "utf-8"));
  expect(exported.projectCopies.map((copy: { name: string }) => copy.name)).toEqual([
    expect.stringMatching(/^projects\.conflict-.*\.yml$/),
  ]);
  expect(exported.projectCopies[0].text).toBe("sample-b:\n  keywords: [beta]\n");

  page.once("dialog", (dialog) => void dialog.accept());
  await listed.first().getByRole("button", { name: "Delete" }).click();
  await expect(listed).toHaveCount(0);
  await expect(page.locator("#copies-empty")).toBeVisible();
});

test("a storage error during Sync now shows the error, not Syncing...", async ({ page }) => {
  // Reads of the settings store fail once the test turns the fault on.
  await page.addInitScript(() => {
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (this: IDBObjectStore, ...args: [IDBValidKey | IDBKeyRange]) {
      if ((window as unknown as { __failSettingsReads?: boolean }).__failSettingsReads && this.name === "settings") {
        throw new DOMException("injected storage failure", "UnknownError");
      }
      return get.apply(this, args);
    } as typeof get;
  });
  await openApp(page);
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.evaluate(() => {
    (window as unknown as { __failSettingsReads?: boolean }).__failSettingsReads = true;
  });
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(page.locator("#set-status")).toContainText("Sync failed: injected storage failure");
  await expect(page.locator("#set-status")).not.toHaveText("Syncing...");
});
