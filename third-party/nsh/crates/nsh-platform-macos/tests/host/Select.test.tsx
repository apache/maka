// A selectable view's `onSelectionChange` on the macOS host (`nsh test
// crates/nsh-platform-macos/tests/host --target macos`): a drag reports the
// selected text with the box around it in the view and in the root view,
// one line high within a text and two across both, and nothing once the
// selection goes.
import { expect, open, test } from "nsh/test";

test("a selection reports its box in the view and in the root view", async () => {
  const app = await open("./Select.tsx", { width: 400, height: 300 });
  expect(app.shows("Selected: none")).toBe(true);
  // The first text, from its middle back to its start.
  await app.drag("text:Alpha beta gamma", { x: -150, y: 0 });
  await app.waitFor("text:/^Selected: \\d+ chars, inside, moved, one line$/");
  // From its middle down into the second.
  await app.drag("text:Alpha beta gamma", { x: 0, y: 30 });
  await app.waitFor("text:/^Selected: \\d+ chars, inside, moved, two lines$/");
  // A click puts the caret: nothing selected.
  await app.drag("text:Delta epsilon", { x: 1, y: 0 });
  await app.waitFor("Selected: none");
});
