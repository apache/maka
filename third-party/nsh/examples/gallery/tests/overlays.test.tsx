// The overlay demos (Overlay, Popover, Tooltip, Sheet) on a phone (headless runs are touch screens): the
// overlay over a clipping box, a popover, a tooltip the app opens (touch
// screens show none of their own), a sheet; Escape and back close the top
// one. Then on a desktop: tooltips follow the mouse. Menus: menus.test.tsx.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("../App.tsx", { clock: {} });
});

/** Opens the demo of the overlay `name`, once `text` shows. */
async function show(name: string, text: string) {
  await app.press(`role:button[${name}]`);
  await app.waitFor(text);
}

test("an overlay shows outside the box that clips it and closes on a press outside", async () => {
  await show("Overlay", "Open the overlay");
  await app.press("Open the overlay");
  await app.waitFor("Outside the clipped box, on top of the page.");
  await app.waitFor("overlay at bottom");
  // The placement's tabs lie outside it: a press there closes it.
  await app.press("role:tab[Above]");
  expect(app.texts()).not.toContain("Outside the clipped box, on top of the page.");
});

test("a popover opens from its trigger and back closes it", async () => {
  await show("Popover", "Show the popover");
  await app.press("Show the popover");
  await app.waitFor("A press outside, Escape or back closes it.");
  await app.waitFor("popover opened (triggerPress)");
  await app.back();
  await app.waitFor("popover closed (cancel)");
});

test("Escape cancels a popover without navigating away", async () => {
  await show("Popover", "Show the popover");
  await app.press("Show the popover");
  await app.waitFor("popover opened (triggerPress)");
  await app.keyboard.press("escape");
  await app.waitFor("popover closed (cancel)");
  await app.waitFor("A press outside, Escape or back closes it.", { state: "gone" });
  await app.waitFor("Show the popover");
});

test("a tooltip the app opens shows on a touch screen, which shows none of its own", async () => {
  await show("Tooltip", "Pin the tooltip");
  await app.longPress("Save");
  expect(app.texts()).not.toContain("Saves the document");
  await app.press("Pin the tooltip");
  await app.waitFor("Shown while pinned or hovered");
  await app.press("Unpin the tooltip");
  await app.waitFor("Pin the tooltip");
  expect(app.texts()).not.toContain("Shown while pinned or hovered");
});

test("a sheet closes with back", async () => {
  await show("Sheet", "Show the sheet");
  await app.press("Show the sheet");
  await app.waitFor("The backdrop, Escape and back close it.");
  await app.back();
  await app.waitFor("sheet closed (cancel)");
});

test("on a desktop, tooltips show while the mouse rests on their element", async () => {
  const desk = await open("../App.tsx", { platform: "macos", clock: {} });
  await desk.press("role:button[Tooltip]");
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
  await desk.hover("Save");
  await desk.waitFor("tooltip hidden (hover)");
  expect(desk.texts()).not.toContain("Shown while pinned or hovered");
});
