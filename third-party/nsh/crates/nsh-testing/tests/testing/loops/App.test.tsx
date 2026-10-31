import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

/** The spinner's angle the app last read. */
const angle = (app: App) =>
  Number(app.texts().find((t) => t.startsWith("Angle: "))?.slice("Angle: ".length));

test("a step does not wait for an animation that loops forever", async () => {
  const app = await open("./App.tsx");
  const started = Date.now();
  await app.press("Upload");
  await app.waitFor("Status: uploading");
  // Not the 2 s a step waits for an app that never goes quiet.
  expect(Date.now() - started).toBeLessThan(1000);
  await app.waitFor("Status: uploaded");
});

test("on a manual clock, a loop runs with the clock and never moves it", async () => {
  const app = await open("./App.tsx", { clock: {} });
  const started = Date.now();
  await app.press("Upload");
  // The timer 1 s away has not run: the spinner took no frames of its own.
  expect(app.shows("Status: uploading")).toBe(true);
  await app.waitFor("Status: uploading");
  await app.press("Read");
  expect(angle(app)).toBeGreaterThanOrEqual(0);
  expect(angle(app)).toBeLessThan(30);
  expect(Date.now() - started).toBeLessThan(1000);
  // Half a turn in 450 ms of the clock.
  await app.clock!.runFor(450);
  await app.press("Read");
  expect(angle(app)).toBeGreaterThan(150);
  expect(angle(app)).toBeLessThan(210);
  await app.clock!.runFor(600);
  expect(app.shows("Status: uploaded")).toBe(true);
});
