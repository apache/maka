// The Images demo: its sections, "Reload" and "Show" change what loads,
// and the size and prefetch buttons ask the platform.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open(".", { clock: {} });
  await app.press("label:Images");
});

test("shows its sections", () => {
  for (const text of [
    "Resize modes",
    "A portrait photo in wide frames",
    "cover",
    "center",
    "Corners and borders",
    "Two corners",
    "logo@2x.png, tinted natively",
    "Original",
    "Danger",
    "spinner.webp",
    "Scaled, round",
    "300 ms",
    "Loads",
    "None",
    "16 pt",
    "—",
    "0% · not shown",
    "Prefetch, then show: no download, no progress",
    "Loaded, … px",
    "Loading…",
    "No load events yet",
  ]) {
    expect(app.texts()).toContain(text);
  }
});

test("reload loads the images again and show shows the large one", async () => {
  const texts = app.texts();
  expect(texts[texts.indexOf("Loads") + 1]).toBe("1");
  await app.press("Reload");
  const reloaded = app.texts();
  expect(reloaded[reloaded.indexOf("Loads") + 1]).toBe("2");
  await app.press("Show");
  await app.waitFor("Hide");
});

test("the size and prefetch buttons ask the platform", async () => {
  // A headless run has no images: the platform answers with an error.
  await app.press("Size");
  await app.waitFor("headless runs load no images");
  await app.press("Prefetch");
  await app.waitFor("failed");
});
