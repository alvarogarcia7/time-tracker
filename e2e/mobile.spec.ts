// The mobile editor: add and change entries from a phone-sized screen, save them, and see them again.
import { expect, test } from "@playwright/test";
import { createToday, openApp } from "./helpers";

test.use({ viewport: { width: 390, height: 780 } });

test("@smoke entries are added and changed with the sheet, saved, and still there after a reload", async ({ page }) => {
  await openApp(page);
  await createToday(page);
  await page.getByRole("tab", { name: "Editor mobile", exact: true }).click();
  await expect(page.getByRole("button", { name: "Choose a day" })).toBeVisible();

  await page.getByRole("button", { name: "+ Add entry" }).click();
  await page.getByLabel("Start time").fill("08:00");
  await page.getByLabel("Description").fill("wake up");
  await page.getByRole("button", { name: "Add entry", exact: true }).click();

  await page.getByRole("button", { name: "+ Add entry" }).click();
  await page.getByLabel("Start time").fill("09:30");
  await page.getByLabel("Description").fill("breakfast");
  await page.getByRole("button", { name: "Add entry", exact: true }).click();

  await expect(page.locator(".m-card")).toHaveCount(2);
  await expect(page.locator(".m-card").first()).toContainText("08:00");
  await expect(page.locator(".m-card").first()).toContainText("09:30");
  await expect(page.locator(".m-card").first()).toContainText("1h 30m");
  await expect(page.locator(".m-card").last()).toContainText("open");

  await page.locator(".m-card").first().click();
  await page.getByLabel("Description").fill("wake up slowly");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator(".m-card").first()).toContainText("wake up slowly");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: "Saved" })).toBeDisabled();

  await page.reload();
  await page.getByRole("tab", { name: "Editor mobile", exact: true }).click();
  await expect(page.locator(".m-card")).toHaveCount(2);
  await expect(page.locator(".m-card").first()).toContainText("wake up slowly");
});

test("an entry is deleted with a second tap, and the sheet closes without changes", async ({ page }) => {
  await openApp(page);
  await createToday(page);
  await page.getByRole("tab", { name: "Editor mobile", exact: true }).click();
  await page.getByRole("button", { name: "+ Add entry" }).click();
  await page.getByLabel("Start time").fill("10:00");
  await page.getByLabel("Description").fill("read");
  await page.getByRole("button", { name: "Add entry", exact: true }).click();
  await expect(page.locator(".m-card")).toHaveCount(1);

  await page.locator(".m-card").click();
  await page.getByLabel("Description").fill("never kept");
  await page.getByRole("button", { name: "Close without saving" }).click();
  await expect(page.locator(".m-card")).toContainText("read");

  await page.locator(".m-card").click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.locator(".m-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Confirm delete" }).click();
  await expect(page.locator(".m-card")).toHaveCount(0);
});

for (const width of [320, 360, 390]) {
  test(`nothing scrolls sideways at ${width} px, with long text and the sheet open`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    await openApp(page);
    await createToday(page);
    await page.getByRole("tab", { name: "Editor mobile", exact: true }).click();
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const wide = () =>
      page.evaluate(() => [...document.querySelectorAll("body *")].filter((node) => node.getBoundingClientRect().right > window.innerWidth + 1 && node.getClientRects().length).map((node) => node.className || node.tagName).slice(0, 5));

    await page.getByRole("button", { name: "+ Add entry" }).click();
    await page.getByLabel("Start time").fill("08:00");
    await page.getByLabel("Description").fill(`${"unbrokenwordwithoutanyspaces".repeat(6)} and more words here to wrap`);
    await page.getByLabel("Find or add a project").fill("a-really-long-project-name:with:many:parts:and-more");
    expect(await overflow(), "sheet").toBeLessThanOrEqual(0);
    expect(await wide(), "sheet overflowing nodes").toEqual([]);
    await page.getByRole("button", { name: "Add entry", exact: true }).click();
    await expect(page.locator(".m-card")).toHaveCount(1);
    expect(await overflow(), "list").toBeLessThanOrEqual(0);
    expect(await wide(), "list overflowing nodes").toEqual([]);

    await page.getByRole("button", { name: "Choose a day" }).click();
    expect(await overflow(), "days").toBeLessThanOrEqual(0);
    expect(await wide(), "days overflowing nodes").toEqual([]);
  });
}

test("Escape closes the sheet and the focus goes back to the card; Tab stays in the sheet", async ({ page }) => {
  await openApp(page);
  await createToday(page);
  await page.getByRole("tab", { name: "Editor mobile", exact: true }).click();
  await page.getByRole("button", { name: "+ Add entry" }).click();
  await page.getByLabel("Start time").fill("10:00");
  await page.getByLabel("Description").fill("read");
  await page.getByRole("button", { name: "Add entry", exact: true }).click();

  await page.locator(".m-card").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  for (let step = 0; step < 25; step++) await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.querySelector(".m-sheet")?.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("button", { name: "+ Add entry" })).toBeVisible();

  await page.getByRole("button", { name: "Choose a day" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("Add one after starts where the changed entry ends", async ({ page }) => {
  await openApp(page);
  await createToday(page);
  await page.getByRole("tab", { name: "Editor mobile", exact: true }).click();
  for (const [time, text] of [["08:00", "one"], ["10:00", "two"]]) {
    await page.getByRole("button", { name: "+ Add entry" }).click();
    await page.getByLabel("Start time").fill(time);
    await page.getByLabel("Description").fill(text);
    await page.getByRole("button", { name: "Add entry", exact: true }).click();
  }
  await page.locator(".m-card").first().click();
  await page.getByLabel("Start time").fill("08:00");
  await page.getByRole("button", { name: "Add one after" }).click();
  await expect(page.getByLabel("Start time")).toHaveValue("10:00");
});

test("a start time the files cannot read is refused in the sheet, and 7.15 is read as 07:15", async ({ page }) => {
  await openApp(page);
  await createToday(page);
  await page.getByRole("tab", { name: "Editor mobile", exact: true }).click();
  await page.getByRole("button", { name: "+ Add entry" }).click();
  await page.getByLabel("Start time").fill("quarter past nine");
  await page.getByLabel("Description").fill("emails");
  await page.getByRole("button", { name: "Add entry", exact: true }).click();
  await expect(page.getByText("is not a time. Use a time like 08:30")).toBeVisible();
  await expect(page.locator(".m-card")).toHaveCount(0);

  await page.getByLabel("Start time").fill("7.15");
  await page.getByRole("button", { name: "Add entry", exact: true }).click();
  await expect(page.locator(".m-card")).toContainText("07:15");
  await expect(page.locator(".m-banner")).not.toContainText("line");
});

test("a tap beside the sheet asks before it drops what was typed", async ({ page }) => {
  await openApp(page);
  await createToday(page);
  await page.getByRole("tab", { name: "Editor mobile", exact: true }).click();
  await page.getByRole("button", { name: "+ Add entry" }).click();
  await page.getByLabel("Description").fill("a draft worth keeping");

  const prompts: string[] = [];
  page.on("dialog", (dialog) => {
    prompts.push(dialog.message());
    void dialog.dismiss();
  });
  await page.locator(".m-backdrop").click({ position: { x: 20, y: 20 } });
  expect(prompts).toEqual(["Throw away what you typed in this entry?"]);
  await expect(page.getByLabel("Description")).toHaveValue("a draft worth keeping");
});

test("a new project gets the category chosen in the sheet", async ({ page }) => {
  await openApp(page);
  await createToday(page);
  await page.getByRole("tab", { name: "Editor mobile", exact: true }).click();
  await page.getByRole("button", { name: "+ Add entry" }).click();
  await page.getByLabel("Start time").fill("09:00");
  await page.getByLabel("Description").fill("proofreading");
  await page.getByLabel("Find or add a project").fill("translation:okafor");
  await page.getByLabel("Category of the new project").selectOption("professional");
  await page.getByRole("button", { name: /Add “translation:okafor”/ }).click();
  await page.getByRole("button", { name: "Add entry", exact: true }).click();

  await page.getByRole("tab", { name: "Projects", exact: true }).click();
  await expect(page.locator(".project-table tbody tr", { hasText: "translation:okafor" })).toContainText("professional");
});

test("the project table has no sideways scroll on a phone", async ({ page }) => {
  await openApp(page);
  await page.getByRole("tab", { name: "Projects", exact: true }).click();
  await page.locator("#new-name").fill("a-long-project-name:with:many:parts");
  await page.locator("#new-keywords").fill("one long keyword, another long keyword, and a third keyword here");
  await page.locator("#add-project").click();
  await expect(page.locator(".project-table tbody tr")).toHaveCount(1);
  const scrolls = await page.evaluate(() => [...document.querySelectorAll("section.card, .project-table")].filter((node) => node.scrollWidth > node.clientWidth).length);
  expect(scrolls).toBe(0);
});

test("Files to fix says which entry has no category", async ({ page }) => {
  await openApp(page);
  await createToday(page);
  await page.getByRole("tab", { name: "Editor mobile", exact: true }).click();
  await page.getByRole("button", { name: "+ Add entry" }).click();
  await page.getByLabel("Start time").fill("09:00");
  await page.getByLabel("Description").fill("mystery task");
  await page.getByRole("button", { name: "Add entry", exact: true }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByRole("tab", { name: "Files to fix", exact: true }).click();
  await expect(page.locator(".fix-list")).toContainText("“mystery task” has no project");
});
