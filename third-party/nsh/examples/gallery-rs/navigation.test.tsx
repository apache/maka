// The Navigation demo: the screens it pushes, the modals it presents and
// the switch that intercepts the back button.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open(".", { clock: {} });
  await app.press("label:Navigation");
});

test("shows its sections", () => {
  for (const text of [
    "Native stack",
    "Top",
    "Bottom",
    "Screens",
    "headerLargeTitle",
    "Modals",
    "See-through",
    "Back button",
    "Off: the back button pops this screen.",
  ]) {
    expect(app.texts()).toContain(text);
  }
});

test("pushes its screens and goes back from them", async () => {
  for (const [row, shown] of [
    ["Large title", "iOS: the title shrinks into the bar as the content scrolls."],
    ["Custom header items", "Custom title"],
    ["Unsaved changes", "Nothing to lose: back pops"],
  ]) {
    await app.press(row);
    await app.waitFor(shown);
    expect(app.shows("Native stack")).toBe(false);
    await app.back();
    await app.waitFor("Native stack");
  }
});

test("a deep stack pushes level after level and unwinds to the index", async () => {
  await app.press("A deep stack");
  await app.waitFor("1 deep in the stack");
  await app.press("Deeper");
  await app.waitFor("2 deep in the stack");
  await app.press("To the index");
  await app.waitFor("APPS");
  expect(app.shows("Native stack")).toBe(false);
});

test("presents a sheet and a dialog and closes them", async () => {
  await app.press("label:Page sheet");
  for (const text of [
    "pageSheet",
    "Close with the button, the back button (Android) or a swipe down (iOS sheets).",
    "the modal's",
  ]) {
    await app.waitFor(text);
  }
  await app.press("Close");
  await app.waitFor("pageSheet", { state: "gone" });
  await app.press("label:Dialog");
  await app.waitFor("A dialog");
  await app.press("OK");
  await app.waitFor("A dialog", { state: "gone" });
});

test("a sheet closes with the back button", async () => {
  await app.press("label:Page sheet");
  await app.waitFor("pageSheet");
  await app.back();
  await app.waitFor("pageSheet", { state: "gone" });
  expect(app.texts()).toContain("Native stack");
});

test("the switch intercepts the back button while on", async () => {
  await app.press("label:Intercept the back button");
  await app.waitFor("The handler returns true: back presses stay on this screen.");
  expect(app.texts()).toContain("0 presses caught");
  await app.press("label:Intercept the back button");
  await app.waitFor("Off: the back button pops this screen.");
  expect(app.texts()).toContain("0 presses popped");
});
