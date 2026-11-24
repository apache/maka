// Web pages' media capture in the development host
// (`nsh test crates/nsh-platform-macos/tests/host --target macos`), whose
// `nsh.json` declares `webview.media`. For the macOS host only, like
// `App.test.tsx`.
import { open, test } from "nsh/test";

test("a page of an app that declares webview.media has navigator.mediaDevices", async () => {
  const app = await open("./Media.tsx");
  await app.waitFor("Media devices: object", { timeout: 10_000 });
});
