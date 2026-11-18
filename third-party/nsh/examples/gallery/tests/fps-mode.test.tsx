// `setFpsMode`: how the performance monitor shows, whatever the platform
// draws of it (macOS's panel collapses, expands and hides; a platform
// without a panel ignores it): every mode goes through. Headless, and on
// macOS (`nsh test --target macos`), where the panel's own behavior is
// checked natively (`nsh-platform-macos`'s `fps_collapse`).
import { expect, open, test } from "nsh/test";

const desktop = { width: 480, height: 320, platform: "macos" } as const;

test("the app collapses, hides and expands the performance monitor", async () => {
  const app = await open("./fixtures/fps-mode.tsx", desktop);
  await app.press("id:measure");
  for (const [id, mode] of [["collapse", "collapsed"], ["hide", "hidden"], ["expand", "expanded"]]) {
    await app.press(`id:${id}`);
    await app.waitFor(`text:Mode ${mode}`);
  }
  expect(app.shows("text:Mode expanded")).toBe(true);
});
