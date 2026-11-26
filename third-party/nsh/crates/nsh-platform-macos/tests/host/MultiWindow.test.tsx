// `windowSize()` with two windows of the app's own on the macOS host
// (`nsh test crates/nsh-platform-macos/tests/host --target macos`, #2912):
// it is the primary window's content size, the first window still open,
// never the hidden host's, and it follows the next window when the first
// closes. For the macOS host only, like `App.test.tsx`.
import { expect, open, test } from "nsh/test";

test("windowSize is the first window's content size, then the next one's", async () => {
  const app = await open("./MultiWindow.tsx");
  await app.waitFor("first windowSize: 480x600");
  await app.waitFor("second windowSize: 480x600");
  expect(app.window("first").state()!.contentBounds.size.width).toBe(480);
  // The hidden host's window (1200x800) is never the app's size.
  const seen = app.texts().find((t) => t.startsWith("first seen: "))!;
  expect(seen).not.toContain("1200x800");

  await app.window("first").pressClose();
  await app.waitUntil(() => app.window("first").state() === null);
  await app.waitFor("second windowSize: 360x300");
});
