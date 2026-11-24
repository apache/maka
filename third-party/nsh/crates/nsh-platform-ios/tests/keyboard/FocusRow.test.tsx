// A `focusable` view that takes no presses gets the keyboard focus from a
// tap recognizer of its own. That tap only watches: the views inside the
// focusable one keep their presses. A touch on a stop inside is that
// stop's: an input takes the focus, and a pressable view (a control) takes
// its press and no focus, as UIKit's controls take none from a tap.
import { expect, open, test } from "nsh/test";

test("a pressable inside a focusable view takes its press and leaves the focus where it was", async () => {
  const app = await open("./FocusRow.tsx");
  await app.press("id:plain");
  await app.waitFor("text:focus:row");
  await app.press("id:more");
  await app.waitFor("text:pressed:more");
  // Neither the control nor the row's tap, which ends with the touch,
  // moves the focus.
  await app.wait(300);
  expect(app.shows("text:focus:row")).toBe(true);
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
