import { expect, open, test } from "nsh/test";

// A desktop app's content is in a window of its own (its implicit
// `<Window>`): a dialog in it shows in that window, where the presses go
// (#3242).
test("a press inside an open Dialog reaches its view", async () => {
  const app = await open("./Dialog.tsx", { platform: "macos", width: 400, height: 300 });
  await app.press("inside");
  await app.waitFor("presses=1");
});

test("Enter on a focused view inside an open Dialog presses it", async () => {
  const app = await open("./Dialog.tsx", { platform: "macos", width: 400, height: 300 });
  await app.keyboard.press("tab");
  await app.keyboard.press("enter");
  await app.waitFor("presses=1");
});
