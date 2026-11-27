// Cmd+Shift+Z (#3245): the app's binding hears it before the Edit menu's
// Redo, and without a binding Undo and Redo run once in an input and a rich editor.
import { expect, open, test } from "nsh/test";

test("the keymap hears Cmd+Shift+Z next to the Edit menu's Redo", async () => {
  const app = await open("./Keymap.tsx");
  await app.keyboard.press("mod+z");
  await app.keyboard.press("mod+shift+z");
  await app.keyboard.press("mod+a");
  await app.waitFor("text:log: mod+z mod+shift+z mod+a");
});

test("Cmd+Z undoes and Cmd+Shift+Z redoes once in an input", async () => {
  const app = await open("./Redo.tsx");
  await app.type("id:field", "ab");
  await app.waitFor("Text: ab");
  // Moving the caret ends the typing step: "c" is a second step.
  await app.keyboard.press("Left");
  await app.keyboard.press("c");
  await app.waitFor("Text: acb");
  await app.keyboard.press("mod+z");
  await app.waitFor("Text: ab");
  await app.keyboard.press("mod+z");
  await app.waitFor("Text: ");
  // One redo brings back the first step only: run twice, it would bring both.
  await app.keyboard.press("mod+shift+z");
  await app.waitFor("Text: ab");
  await app.wait(100);
  expect(app.texts()).not.toContain("Text: acb");
});

test("Cmd+Z undoes in the input edited, not in one edited before", async () => {
  const app = await open("./Redo.tsx");
  await app.type("id:field", "ab");
  await app.waitFor("Text: ab");
  await app.type("id:other", "x");
  await app.waitFor("Other: x");
  await app.keyboard.press("mod+z");
  await app.waitFor("Other: ");
  // The first input's typing is not the second's to undo.
  await app.keyboard.press("mod+z");
  await app.wait(100);
  expect(app.texts()).toContain("Text: ab");
  expect(app.texts()).toContain("Other: ");
});

test("Cmd+Shift+Z redoes once in a rich editor", async () => {
  const app = await open("./Redo.tsx");
  await app.type("id:editor", "one");
  await app.waitFor("one");
  // Past the history's grouping delay: "two" is a second step.
  await app.wait(700);
  await app.keyboard.press("space");
  await app.keyboard.press("t");
  await app.keyboard.press("w");
  await app.keyboard.press("o");
  await app.waitFor("one two");
  await app.keyboard.press("mod+z");
  await app.keyboard.press("mod+z");
  await app.wait(100);
  expect(app.shows("one")).toBe(false);
  // One redo brings back the first step only: run twice, it would bring both.
  await app.keyboard.press("mod+shift+z");
  await app.waitFor("one");
  await app.wait(100);
  expect(app.shows("one two")).toBe(false);
});
