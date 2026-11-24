// A mode asked for while AppKit animates into or out of full screen, on the
// macOS host (`nsh test crates/nsh-platform-macos/tests/host --target
// macos`): AppKit ignores `toggleFullScreen:` until the animation is over,
// so the window holds the last mode asked for and takes it then, instead of
// staying in full screen. `FullScreen.tsx`.
//
// Needs an unlocked desktop session: AppKit ignores `toggleFullScreen:`
// while the screen is locked, and the window stays in `normal`.
import { expect, open, test } from "nsh/test";

// Longer than AppKit's full screen animation.
const transition = () => new Promise((resolve) => setTimeout(resolve, 2500));

test("leaving full screen as it begins ends in a normal window", async () => {
  const app = await open("./FullScreen.tsx");
  await app.waitFor("Mode: normal");
  await app.press("label:Full screen and back");
  // In, then out once the animation in is over.
  await app.waitFor("Mode: fullScreen", { timeout: 10000 });
  await app.waitFor("Mode: normal", { timeout: 10000 });
  await transition();
  expect(app.texts()).toContain("Mode: normal");
});

test("normal right after entering full screen leaves it once in", async () => {
  const app = await open("./FullScreen.tsx");
  await app.waitFor("Mode: normal");
  await app.keyboard.press("f");
  await app.waitFor("Mode: fullScreen", { timeout: 10000 });
  // Still animating in.
  await app.keyboard.press("n");
  await app.waitFor("Mode: normal", { timeout: 10000 });
  await transition();
  expect(app.texts()).toContain("Mode: normal");
});

test("full screen right after leaving it enters again once out", async () => {
  const app = await open("./FullScreen.tsx");
  await app.waitFor("Mode: normal");
  await app.keyboard.press("f");
  await app.waitFor("Mode: fullScreen", { timeout: 10000 });
  await transition();
  await app.keyboard.press("n");
  await app.waitFor("Mode: normal", { timeout: 10000 });
  // Still animating out.
  await app.keyboard.press("f");
  await app.waitFor("Mode: fullScreen", { timeout: 10000 });
  await transition();
  expect(app.texts()).toContain("Mode: fullScreen");
  await app.keyboard.press("n");
  await app.waitFor("Mode: normal", { timeout: 10000 });
});

test("hidden on its way into full screen, it leaves it and goes", async () => {
  const app = await open("./FullScreen.tsx");
  await app.waitFor("Visible: true");
  await app.keyboard.press("f");
  await app.waitFor("Mode: fullScreen", { timeout: 10000 });
  // Still animating in.
  await app.keyboard.press("h");
  await app.waitFor("Visible: false", { timeout: 10000 });
  await transition();
  expect(app.texts()).toContain("Mode: normal");
});
