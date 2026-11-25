// The installable parts: the manifest, the icons, the service worker, the layout on a phone.
import { expect, test } from "@playwright/test";
import { createToday, openApp, waitForServiceWorker } from "./helpers";

test("the manifest is served, is valid JSON, and names the start page and the icons", async ({ page, request }) => {
  await openApp(page);
  const link = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(link).toBe("manifest.webmanifest");
  const response = await request.get(link ?? "manifest.webmanifest");
  expect(response.status()).toBe(200);
  const manifest = JSON.parse(await response.text());
  expect(manifest.name).toBeTruthy();
  expect(manifest.short_name).toBeTruthy();
  expect(manifest.start_url).toBe("./");
  expect(manifest.scope).toBe("./");
  expect(manifest.display).toBe("standalone");
  expect(manifest.theme_color).toBeTruthy();
  expect(manifest.background_color).toBeTruthy();
  const sizes = (manifest.icons as { sizes: string; purpose?: string }[]).map((icon) => `${icon.sizes}:${icon.purpose ?? "any"}`);
  expect(sizes).toEqual(expect.arrayContaining(["192x192:any", "512x512:any", "512x512:maskable"]));
});

test("the apple touch icon is a 180 pixel PNG that the page links to", async ({ page, request }) => {
  await openApp(page);
  const href = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
  expect(href).toBe("apple-touch-icon.png");
  const response = await request.get(href ?? "apple-touch-icon.png");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("image/png");
  const bytes = await response.body();
  // IHDR: width and height are at bytes 16 to 23 of a PNG.
  expect(bytes.readUInt32BE(16)).toBe(180);
  expect(bytes.readUInt32BE(20)).toBe(180);
});

test("the service worker registers and controls the page after a reload", async ({ page }) => {
  await openApp(page);
  const registered = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.state ?? null;
  });
  expect(["activated", "activating", "installed"]).toContain(registered ?? "missing");
  await waitForServiceWorker(page);
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
});

test("a path the site does not have goes to the start page", async ({ page }) => {
  await page.goto("./some/deep/link");
  await expect(page).toHaveURL(/\/time-tracker\/index\.html/);
  await expect(page.getByRole("tab", { name: "Editor" })).toBeVisible();
});

test("no page scrolls sideways at a 375 pixel width", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await openApp(page);
  await createToday(page);
  await page.getByRole("button", { name: "Plain text", exact: true }).click();
  await page.locator("#plain-text").fill("11/11/2026\n- [ ] 0800 a long description that keeps going well past the edge of a phone screen\n- [ ] 0900 next\n");
  await page.getByRole("button", { name: "Entries", exact: true }).click();

  const overflow = async () =>
    page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  for (const tab of ["Editor", "Viewer", "Reports", "Projects", "Settings"]) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(page.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
    expect(await overflow(), `${tab} scrolls sideways`).toBeLessThanOrEqual(0);
  }
});
