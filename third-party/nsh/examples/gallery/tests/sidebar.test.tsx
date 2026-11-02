// The desktop layout's sidebar: its demos are one stop of Tab, as a macOS
// source list is, whose Up and Down select the demo before and after while
// it has the keyboard focus; Tab moves on to the rest of the window.
import { expect, open, test } from "nsh/test";

// The leads of the demos after Checkbox.
const COLLAPSIBLE = "Details under a summary, kept while collapsed";
const COLOR_PICKER = "An area, sliders of RGB, HSL, HSB or OKLCH, a field and swatches";

test("the sidebar's demos are one stop of Tab, whose Up and Down select the demos", async () => {
  const app = await open("../App.tsx", { platform: "macos", width: 1200, height: 800, clock: {} });
  await app.press("role:button[Checkbox]");
  await app.waitFor("Select all");
  // From the search field above them (`mod+k`), one Tab reaches the demos
  // (the page's stops come before or after the sidebar's by the
  // platform's order, so the test starts beside the list): Down there
  // selects Collapsible, the demo after Checkbox (components go by name).
  await app.keyboard.press("mod+k");
  await app.keyboard.press("tab");
  await app.keyboard.press("down");
  await app.waitFor(COLLAPSIBLE);
  await app.keyboard.press("down");
  await app.waitFor(COLOR_PICKER);
  await app.keyboard.press("up");
  await app.waitFor(COLLAPSIBLE);
  // One stop: one Tab leaves the demos, so Down no longer selects the next
  // one, and one Shift+Tab comes back to them.
  await app.keyboard.press("tab");
  await app.keyboard.press("down");
  await app.wait(100);
  expect(app.shows(COLOR_PICKER)).toBe(false);
  await app.keyboard.press("shift+tab");
  await app.keyboard.press("up");
  await app.waitFor("Select all");
});
