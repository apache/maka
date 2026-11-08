// The desktop layout's sidebar: its demos are one stop of Tab, as a macOS
// source list is, whose Up and Down select the demo before and after while
// it has the keyboard focus; Tab moves on to the rest of the window.
import { expect, open, test } from "nsh/test";

// The leads of the demos after Checkbox.
const RADIO = "A plan picker: one of a small set, a disabled plan";
const SWITCH = "Settings that take effect at once, one that needs another on";

test("the sidebar's demos are one stop of Tab, whose Up and Down select the demos", async () => {
  const app = await open("../App.tsx", { platform: "macos", width: 1200, height: 800, clock: {} });
  // Checkbox sits under the sidebar's footer until the list scrolls.
  await app.scroll("role:button[Checkbox]", 200);
  await app.press("role:button[Checkbox]");
  await app.waitFor("Select all");
  // From the search field above them (`mod+k`), one Tab reaches the demos
  // (the page's stops come before or after the sidebar's by the
  // platform's order, so the test starts beside the list): Down there
  // selects Radio, the demo after Checkbox under Inputs.
  await app.keyboard.press("mod+k");
  await app.keyboard.press("tab");
  await app.keyboard.press("down");
  await app.waitFor(RADIO);
  await app.keyboard.press("down");
  await app.waitFor(SWITCH);
  await app.keyboard.press("up");
  await app.waitFor(RADIO);
  // One stop: one Tab leaves the demos, so Down no longer selects the next
  // one, and one Shift+Tab comes back to them.
  await app.keyboard.press("tab");
  await app.keyboard.press("down");
  await app.wait(100);
  expect(app.shows(SWITCH)).toBe(false);
  // Down opens the settings menu now that the footer is one menu trigger.
  // Escape returns focus to that trigger before Shift+Tab returns to the demos.
  await app.keyboard.press("escape");
  await app.keyboard.press("shift+tab");
  await app.keyboard.press("up");
  await app.waitFor("Select all");
});
