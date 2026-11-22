// App-level keyboard shortcuts (nsh/keymap): the System demo's, on a
// desktop (headless, the app runs as macOS; on a real platform, as it).
import { open, test } from "nsh/test";

test("the shortcuts count, switch the light and reset", async () => {
  const app = await open("../App.tsx", { platform: "macos" });
  await app.press("label:System");
  await app.waitFor("Counted 0");
  await app.keyboard.press("mod+k");
  await app.waitFor("Counted 1");
  await app.keyboard.press("mod+shift+l");
  await app.waitFor("Light on");
  await app.keyboard.press("mod+backspace");
  await app.waitFor("Counted 0");
});
