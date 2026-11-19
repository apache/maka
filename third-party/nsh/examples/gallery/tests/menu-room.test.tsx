// A long menu in a short desktop window keeps to the room below its
// trigger: its items scroll inside the popup, whose surface (the gallery's
// `menuPopup`) stays put; the keys bring the item they reach into view and
// page by what the popup shows, stopping at the ends.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("./fixtures/menu-room.tsx", { platform: "macos", width: 480, height: 360, clock: {} });
  await app.press("Time zone");
  await app.waitFor("Zone 1");
});

test("the popup keeps to the room below its trigger", async () => {
  await app.waitFor("text:held: true");
});

test("End reaches the last zone past the room, and Return chooses it", async () => {
  await app.keyboard.press("end");
  await app.keyboard.press("enter");
  await app.waitFor("text:chose: Zone 30");
});

test("Page Down goes a view at a time and stops at the last zone", async () => {
  await app.keyboard.press("pagedown");
  await app.keyboard.press("enter");
  await app.waitUntil(() => !app.shows("text:chose: none"));
  // A view on: neither the first zone nor the last.
  expect(app.shows("text:chose: Zone 1")).toBe(false);
  expect(app.shows("text:chose: Zone 30")).toBe(false);
  await app.press("Time zone");
  await app.waitFor("Zone 1");
  for (let i = 0; i < 12; i++) await app.keyboard.press("pagedown");
  await app.keyboard.press("enter");
  await app.waitFor("text:chose: Zone 30");
});
