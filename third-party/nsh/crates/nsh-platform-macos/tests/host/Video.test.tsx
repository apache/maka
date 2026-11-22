// Restarting a video that played to its end, on a real AVPlayer
// (`nsh test crates/nsh-platform-macos/tests/host --target macos`). For the
// macOS host only, like `App.test.tsx`: headless runs play no video.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

const CLIP_MS = 3000;

async function playToEnd(): Promise<App> {
  const app = await open("./Video.tsx");
  await app.waitFor("Duration: 3.0", { timeout: 10_000 });
  await app.press("Play");
  await app.waitFor("Ends: 1", { timeout: 10_000 });
  return app;
}

// How long the last run took, from the press that started it to `onEnd`.
function lastRun(app: App): number {
  const text = app.texts().find((t) => t.startsWith("Run: "));
  return Number(text?.slice("Run: ".length));
}

test("seeking to 0 and unpausing in one turn plays the clip again to its end", async () => {
  const app = await playToEnd();
  await app.press("Restart");
  await app.waitFor("text:/^Time: 1\\.\\d$/");
  await app.waitFor("Ends: 2", { timeout: 10_000 });
  expect(lastRun(app)).toBeGreaterThanOrEqual(CLIP_MS - 500);
});

test("seeking a paused video does not play it", async () => {
  const app = await playToEnd();
  await app.press("Seek to start");
  await app.wait(2000);
  expect(app.shows("Ends: 1")).toBe(true);
  // Played on, it would be about 2 s in; standing still, it shows 0 or the
  // last progress before the end (2.8 s or later).
  expect(app.shows("text:/^Time: (1\\.\\d|2\\.[0-4])$/")).toBe(false);
  // Sought to 0 and held there: unpaused, the whole clip plays.
  await app.press("Play");
  await app.waitFor("Ends: 2", { timeout: 10_000 });
  expect(lastRun(app)).toBeGreaterThanOrEqual(CLIP_MS - 500);
});

test("seeking a video the app has not paused plays it on after its end", async () => {
  const app = await open("./Video.tsx");
  await app.waitFor("Duration: 3.0", { timeout: 10_000 });
  await app.press("Keep playing at end");
  await app.waitFor("Keeps playing at end");
  await app.press("Play");
  await app.waitFor("Ends: 1", { timeout: 10_000 });
  await app.press("Seek to start");
  await app.waitFor("text:/^Time: 1\\.\\d$/");
  await app.waitFor("Ends: 2", { timeout: 10_000 });
  expect(lastRun(app)).toBeGreaterThanOrEqual(CLIP_MS - 500);
});
