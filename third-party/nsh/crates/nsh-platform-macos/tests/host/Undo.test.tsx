// A shared undo manager can retain actions for an input's text storage after
// JS replaces its value or the editor goes away. Command+Z must not replay
// those stale edits or crash the macOS host.
import { expect, open, test } from "nsh/test";

test("Command+Z after the app cleared a multiline input leaves the app running", async () => {
  const app = await open("./Undo.tsx");
  await app.type("id:note", "abc");
  await app.waitFor("Text: abc");
  await app.press("label:clear");
  await app.waitFor("Text: ");
  await app.keyboard.press("mod+z");
  await app.type("id:note", "x");
  await app.waitFor("Text: x");
});

test(
  "Command+Z after a multiline input became a one line input leaves the app running",
  async () => {
    const app = await open("./Undo.tsx");
    await app.type("id:note", "abc");
    await app.waitFor("Text: abc");
    await app.press("label:single");
    await app.waitFor("id:note");
    await app.keyboard.press("mod+z");
    await app.type("id:note", "x");
    await app.waitFor("Text: abcx");
  },
);

test("Command+Z after a multiline input was removed leaves the app running", async () => {
  const app = await open("./Undo.tsx");
  await app.type("id:note", "abc");
  await app.waitFor("Text: abc");
  await app.press("label:hide");
  expect(app.shows("id:note")).toBe(false);
  await app.keyboard.press("mod+z");
  await app.press("label:show");
  await app.waitFor("id:note");
  await app.type("id:note", "x");
  await app.waitFor("Text: abcx");
});
