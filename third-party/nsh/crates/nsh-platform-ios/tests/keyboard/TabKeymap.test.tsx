// An app shortcut on Tab keeps its precedence over UIKit's focus traversal:
// a prioritized key command runs the binding and consumes the key, as the
// app's other shortcuts do on a press.
import { expect, open, test } from "nsh/test";

test("a Tab binding runs before focus traversal and stays", async () => {
  const app = await open("./TabKeymap.tsx");
  await app.press("id:pad");
  await app.waitFor("text:focus:pad");
  await app.keyboard.press("tab");
  await app.waitFor("text:tab:1");
  expect(app.shows("text:focus:pad")).toBe(true);
});
