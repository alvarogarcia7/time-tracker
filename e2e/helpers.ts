import { expect, Page } from "@playwright/test";

// Today's day in the two forms the app uses: the file name and the header line.
export function today(): { file: string; header: string } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const year = now.getFullYear();
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());
  return { file: `${year}-${month}-${day}.md`, header: `${day}/${month}/${year}` };
}

// Opens the app's start page and waits until the editor is shown.
export async function openApp(page: Page): Promise<void> {
  await page.goto("./");
  await expect(page.getByRole("tab", { name: "Editor" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#editor-file")).toBeVisible();
}

// Waits until the service worker controls the page (it takes a reload after the first visit).
export async function waitForServiceWorker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  if (!(await page.evaluate(() => navigator.serviceWorker.controller !== null))) {
    await page.reload();
  }
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 30_000 })
    .toBe(true);
}

// Creates today's day file from the editor's New day control and returns its name.
export async function createToday(page: Page): Promise<string> {
  const { file } = today();
  const [year, month, day] = file.replace(".md", "").split("-");
  await page.getByLabel("date of a new day").fill(`${year}-${month}-${day}`);
  await page.getByRole("button", { name: "New day", exact: true }).click();
  await expect(page.locator("#editor-file")).toHaveValue(file);
  return file;
}
