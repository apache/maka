// A `focusable` view that takes no presses gets the keyboard focus from a
// tap recognizer of its own. That tap only watches: the views inside the
// focusable one keep their presses, and the innermost stop under the touch
// takes the focus.
import { expect, open, test } from "nsh/test";

test("a pressable inside a focusable view takes its press and the focus", async () => {
  const app = await open("./FocusRow.tsx");
  await app.press("id:more");
  await app.waitFor("text:pressed:more");
  await app.waitFor("text:focus:more");
  // The row's tap ends with the touch: it must not take the focus then.
  await app.wait(300);
  expect(app.shows("text:focus:more")).toBe(true);
});

test("a pressable that is no stop takes its press, and the view around it the focus", async () => {
  const app = await open("./FocusRow.tsx");
  await app.press("id:plain");
  await app.waitFor("text:pressed:plain");
  await app.waitFor("text:focus:row");
});

test("an input inside a focusable view keeps the focus a tap gave it", async () => {
  const app = await open("./FocusRow.tsx");
  // A real touch on the field, as in Keyboard.test.tsx.
  await app.drag("id:field", { x: 0, y: 0 });
  await app.waitFor("text:focus:field");
  await app.wait(300);
  expect(app.shows("text:focus:field")).toBe(true);
  await app.keyboard.press("a");
  await app.waitFor("text:input:a");
});
