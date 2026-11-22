// An Editor's own undo and redo on the macOS host with the app in the
// background (`nsh test crates/nsh-platform-macos/tests/host --target macos`,
// also with `--foreground`), under a menu whose Undo and Redo could take
// the keys first. For the macOS host only, like `App.test.tsx`: it asserts
// the app runs there.
import { expect, open, test } from "nsh/test";

test("Command+Z undoes an Editor's typing and Shift+Command+Z redoes it", async () => {
  const app = await open("./Edit.tsx");
  await app.waitFor("text:/^Real host: (true|false)$/");
  expect(app.shows("Real host: true")).toBe(true);
  // The editor's row of text, as the Editor demo's tests press it.
  await app.press("text:one");
  await app.keyboard.press("mod+down");
  await app.keyboard.press("x");
  await app.waitFor("Text: onex");
  await app.keyboard.press("mod+z");
  await app.waitFor("Text: one");
  await app.keyboard.press("shift+mod+z");
  await app.waitFor("Text: onex");
});
