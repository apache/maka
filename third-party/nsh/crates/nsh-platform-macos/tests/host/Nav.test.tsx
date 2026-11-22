// Command+[ goes back on the macOS host with the app in the background
// (`nsh test crates/nsh-platform-macos/tests/host --target macos`, also with
// `--foreground`): a Command key no menu item takes still reaches the
// window's views. For the macOS host only, like `App.test.tsx`: it asserts
// the app runs there.
import { expect, open, test } from "nsh/test";

test("Command+[ goes back from a pushed screen", async () => {
  const app = await open("./Nav.tsx");
  await app.waitFor("text:/^Real host: (true|false)$/");
  expect(app.shows("Real host: true")).toBe(true);
  await app.press("Open detail");
  await app.waitFor("Page: detail");
  await app.keyboard.press("mod+[");
  await app.waitFor("Page: root");
});
