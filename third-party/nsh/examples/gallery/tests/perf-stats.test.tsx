// `perfStats()`: what the performance monitor measured, read once a second
// while it measures, `null` while it does not. Headless runs measure too
// (they draw no frames: 0); `nsh test --target macos` reads the window's.
import { expect, open, test } from "nsh/test";

const desktop = { width: 400, height: 300, platform: "macos" } as const;

test("the stats read null until the monitor measures, a number while it does, null again once it stops", async () => {
  const app = await open("./fixtures/perf-stats.tsx", desktop);
  expect(app.shows("text:Reading none")).toBe(true);
  await app.press("id:on");
  await app.waitFor("text:Enabled true");
  await app.waitUntil(() => app.texts().some((t) => /^Reading \d+(\.\d+)?$/.test(t)), { timeout: 4000 });
  await app.press("id:off");
  await app.waitFor("text:Enabled false");
  await app.waitFor("text:Reading none");
});
