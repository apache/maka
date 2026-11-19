// With the software keyboard up for an input, a tap on a button beside it
// acts at once and the input keeps the keyboard, as UIKit's controls do:
// the button takes no focus, so the keyboard does not drop and move the
// composer from under the finger. A simulator with a hardware keyboard
// attached shows no software keyboard: then only the presses are checked.
import { expect, open, test } from "nsh/test";

test("a button beside a typing input acts on the first tap and leaves it the keyboard", async () => {
  const app = await open("./Composer.tsx");
  await app.type("id:message", "hi");
  await app.waitFor("text:focus:message");
  const up = app.shows("text:keyboard:up");
  await app.press("id:plus");
  await app.waitFor("text:presses:1");
  await app.wait(500);
  expect(app.shows("text:focus:message")).toBe(true);
  if (up) expect(app.shows("text:keyboard:up")).toBe(true);
  await app.press("id:plus");
  await app.waitFor("text:presses:2");
});

test("a menu beside a typing input opens on the first tap", async () => {
  const app = await open("./Composer.tsx");
  await app.type("id:message", "hi");
  await app.waitFor("text:focus:message");
  await app.press("id:attach");
  await app.press("text:Photo");
  await app.waitFor("text:picked:1");
});

test("an input keeps the focus across two typed characters", async () => {
  // The focus engine reports no next focused view when a text field's own
  // field editor takes the focus (the editor is not a focus item), and
  // `adopt_focus` used to resign the field on that report: the field lost
  // the focus after the first character. Typing two characters in one go is
  // what a person does; the second must land without a second tap.
  //
  // The value is checked case-insensitively: the simulator's keyboard
  // capitalizes the first letter of a sentence, which is not what this test
  // is about.
  const app = await open("./Composer.tsx");
  await app.type("id:message", "hi");
  await app.waitFor("text:focus:message");
  expect(app.shows("text:focus:message")).toBe(true);
  const value = app.shows("text:value:hi") || app.shows("text:value:Hi");
  expect(value).toBe(true);
});
