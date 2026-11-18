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
