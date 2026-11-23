// `paused` on the web: acted on when it changes, so another prop does not
// play a video, while the browser's own pauses (its end, leaving the page)
// leave a video the app has not paused playing on where the other
// platforms do. In Chrome only (`--target web`): headless runs play no video.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

/** The app with the clip played to its end, still unpaused by the app. */
async function playedToEnd(): Promise<App> {
  const app = await open("./App.tsx");
  await app.waitFor("Duration: 3.0", { timeout: 10_000 });
  await app.press("Keep playing at end");
  await app.waitFor("Keeps playing at end");
  await app.press("Play");
  await app.waitFor("Ends: 1", { timeout: 10_000 });
  return app;
}

test("changing another prop leaves a video that ended at its end", async () => {
  const app = await playedToEnd();
  await app.press("Volume 1");
  await app.waitFor("Volume 0.5");
  await app.wait(2000);
  expect(app.shows("Ends: 1")).toBe(true);
  expect(app.shows("text:/^Time: (0\\.\\d|1\\.\\d|2\\.[0-4])$/")).toBe(false);
});

test("seeking a video the app has not paused plays it on after its end", async () => {
  const app = await playedToEnd();
  await app.press("Seek to start");
  await app.waitFor("text:/^Time: 1\\.\\d$/");
  await app.waitFor("Ends: 2", { timeout: 10_000 });
});

test("seeking a paused video does not play it", async () => {
  const app = await open("./App.tsx");
  await app.waitFor("Duration: 3.0", { timeout: 10_000 });
  await app.press("Seek to start");
  await app.wait(2000);
  expect(app.shows("Time: 0.0")).toBe(true);
});

test("a video taken out of the page and put back plays on", async () => {
  const app = await open("./App.tsx");
  await app.waitFor("Duration: 3.0", { timeout: 10_000 });
  await app.press("Play");
  await app.waitFor("text:/^Time: 0\\.[5-9]$/");
  await app.press("Take out");
  await app.waitFor("Put back");
  await app.wait(1000);
  await app.press("Put back");
  await app.waitFor("Ends: 1", { timeout: 10_000 });
});
