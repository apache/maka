// The Overlays demo on a phone (headless runs are touch screens): the
// overlay over a clipping box, a popover, a tooltip the app opens (touch
// screens show none of their own), a sheet; Escape and back close the top
// one. Then on a desktop: tooltips follow the mouse. Menus: menus.test.tsx.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("../App.tsx", { clock: {} });
  await app.press("role:button[Overlays]");
  await app.waitFor("Open the overlay");
});

test("an overlay shows outside the box that clips it and closes on a press outside", async () => {
  await app.press("Open the overlay");
  await app.waitFor("Outside the clipped box, on top of the page.");
  await app.waitFor("overlay at bottom");
  await app.press("Show the sheet");
  expect(app.texts()).not.toContain("Outside the clipped box, on top of the page.");
});

test("a popover opens from its trigger and back closes it", async () => {
  await app.press("Show the popover");
  await app.waitFor("A press outside, Escape or back closes it.");
  await app.waitFor("popover opened (triggerPress)");
  await app.back();
  await app.waitFor("popover closed (cancel)");
});

test("Escape cancels a popover without navigating away", async () => {
  await app.press("Show the popover");
  await app.waitFor("popover opened (triggerPress)");
  await app.keyboard.press("escape");
  await app.waitFor("popover closed (cancel)");
  await app.waitFor("A press outside, Escape or back closes it.", { state: "gone" });
  await app.waitFor("Open the overlay");
});

test("a tooltip the app opens shows on a touch screen, which shows none of its own", async () => {
  await app.longPress("Save");
  expect(app.texts()).not.toContain("Saves the document");
  await app.press("Pin the tooltip");
  await app.waitFor("Shown while pinned or hovered");
  await app.press("Unpin the tooltip");
  await app.waitFor("Pin the tooltip");
  expect(app.texts()).not.toContain("Shown while pinned or hovered");
});

test("a sheet closes with back", async () => {
  await app.press("Show the sheet");
  await app.waitFor("The backdrop, Escape and back close it.");
  await app.back();
  await app.waitFor("sheet closed (cancel)");
});

test("on a desktop, tooltips show while the mouse rests on their element", async () => {
  const desk = await open("../App.tsx", { platform: "macos", clock: {} });
  await desk.press("role:button[Overlays]");
  await desk.waitFor("Save");
  // The text one: the core's bubble, after half a second.
  await desk.hover("Save");
  await desk.wait(300);
  expect(desk.texts()).not.toContain("Saves the document");
  await desk.wait(300);
  await desk.waitFor("Saves the document");
  // `Tooltip`: its delay, its placement, its events; leaving hides the other.
  await desk.hover("Pin the tooltip");
  await desk.wait(400);
  await desk.waitFor("Shown while pinned or hovered");
  await desk.waitFor("tooltip shown (hover)");
  expect(desk.texts()).not.toContain("Saves the document");
  await desk.hover("Open the overlay");
  await desk.waitFor("tooltip hidden (hover)");
  expect(desk.texts()).not.toContain("Shown while pinned or hovered");
});
