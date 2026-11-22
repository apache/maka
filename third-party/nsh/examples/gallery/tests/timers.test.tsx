// Timers and frames on a manual clock: the test moves the app's time, so
// ten seconds pass at once and the frame rate is exactly the display's.
import { expect, open, test } from "nsh/test";

test("the interval ticks once a second", async () => {
  const app = await open("../App.tsx", { clock: {} });
  await app.press("role:button[System]");
  expect(app.texts()).toContain("0 every 1 s");
  await app.clock!.runFor(10_000);
  expect(app.texts()).toContain("10 every 1 s");
});

test("frames come at 60 fps", async () => {
  const app = await open("../App.tsx", { clock: {} });
  await app.press("role:button[System]");
  await app.press("role:button[Count frames]");
  await app.clock!.runFor(1000);
  expect(app.texts()).toContain("60 fps live");
});
