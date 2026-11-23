// `WebViewRef.evaluate` on a real WKWebView
// (`nsh test crates/nsh-platform-macos/tests/host --target macos`). For the
// macOS host only, like `App.test.tsx`: headless runs evaluate nothing.
import { open, test } from "nsh/test";

test("evaluate answers with a script's value", async () => {
  const app = await open("./WebView.tsx");
  await app.press("Sum");
  await app.waitFor("Result: 2", { timeout: 10_000 });
});

test("evaluate awaits a returned Promise", async () => {
  const app = await open("./WebView.tsx");
  await app.press("Title");
  await app.waitFor('Result: "Page"', { timeout: 10_000 });
});
