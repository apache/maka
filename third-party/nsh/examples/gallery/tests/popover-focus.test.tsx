// A popover whose `onOpen` focuses its panel moves the keyboard focus into
// it as it opens; Escape closes it and gives the focus back to the trigger.
import { expect, open, test } from "nsh/test";

test("focusing the panel in onOpen moves the keyboard focus into the popover", async () => {
  const app = await open("./fixtures/popover-focus.tsx", { platform: "macos" });
  await app.keyboard.press("tab");
  await app.waitFor("text:focus trigger");
  await app.keyboard.press("enter");
  await app.waitFor("text:focus trigger panel");
  await app.keyboard.press("escape");
  await app.waitFor("text:focus trigger panel trigger");
  expect(app.shows("text:Panel")).toBe(false);
});
