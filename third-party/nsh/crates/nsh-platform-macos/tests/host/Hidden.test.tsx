// The keyboard focus on the macOS host (`nsh test
// crates/nsh-platform-macos/tests/host --target macos`) and views a hidden
// view holds, though AppKit's key view loop and first responder keep them:
// Tab passes by the controls and inputs of a `display: none` view and a
// `visibility: hidden` one, and a focused control that hides gives the
// focus up, so no key acts on it.
import { expect, open, test } from "nsh/test";

test("Tab passes by what hidden views hold", async () => {
  const app = await open("./Hidden.tsx", { width: 400, height: 300 });
  await app.waitFor("Shown");
  await app.keyboard.press("tab");
  await app.keyboard.press("enter");
  await app.waitFor("text:/pressed/");
  expect(app.texts()).toContain("Log: Shown focused, Shown pressed");
  // On to the tabs' stop, then around to the control again.
  await app.keyboard.press("tab");
  await app.keyboard.press("tab");
  await app.keyboard.press("space");
  await app.waitFor("text:/pressed, .* pressed$/");
  expect(app.texts()).toContain("Log: Shown focused, Shown pressed, Shown focused, Shown pressed");
});

test("a focused control that hides gives up the focus", async () => {
  const app = await open("./Hidden.tsx", { width: 400, height: 300 });
  await app.waitFor("Shown");
  // The control, then the selected tab.
  await app.keyboard.press("tab");
  await app.keyboard.press("tab");
  await app.keyboard.press("x");
  await app.waitFor("Tabs hidden");
  // Right would select the next tab, Return and Space press the focused one.
  await app.keyboard.press("right");
  await app.keyboard.press("enter");
  await app.keyboard.press("space");
  await app.wait(300);
  expect(app.texts()).toContain("Log: Shown focused");
});
