// The Combobox demo on a desktop: a click on the input opens the list and
// another closes it, as a press on the trigger button does. The input hears
// the click as a press, though its text field takes the click too (headless,
// the app runs as macOS; on a real platform, as it).
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("../App.tsx", { platform: "macos", width: 1200, height: 800 });
  await app.press("role:button[Combobox]");
  await app.waitFor("role:combobox[Reviewer]");
});

test("a click on the input opens the list, and another closes it", async () => {
  expect(app.shows("role:option[Grace]")).toBe(false);
  await app.press("role:combobox[Reviewer]");
  await app.waitFor("role:option[Grace]");
  await app.press("role:combobox[Reviewer]");
  await app.waitUntil(() => !app.shows("role:option[Grace]"));
});

test("a click on the input, then a click on an item, chooses it", async () => {
  await app.press("role:combobox[Reviewer]");
  await app.waitFor("role:option[Grace]");
  await app.press("role:option[Grace]");
  await app.waitFor("Reviewer: Grace");
  await app.waitUntil(() => !app.shows("role:option[Linus]"));
});
