// `RichEditor`'s touch selection on a phone: a long press selects the word
// under the finger and opens the system's edit menu (`menu()`), whose
// actions edit through the editor's own transactions, and the app's
// toolbar formats what a touch selected.
import { expect, open, test } from "nsh/test";

const FIRST = "Hold a word to select it";
const SECOND = "Then drag the handles, open the menu, or make it bold with the button above";

const openEditor = () => open("./fixtures/rich-editor-touch.tsx", { platform: "ios" });

/** The text the app shows as selected. */
function selected(app: { texts(): string[] }): string {
  const line = app.texts().find((t) => t.startsWith("selected: ")) ?? "";
  return line.slice("selected: ".length);
}

const labels = (app: { menu(): { label: string }[] | null }) => (app.menu() ?? []).map((e) => e.label);

test("a long press selects a word, and the edit menu copies it", async () => {
  const app = await openEditor();
  await app.longPress(`text:${FIRST}`);
  const word = selected(app);
  expect(/^\w+$/.test(word)).toBe(true);
  expect(FIRST.split(" ").includes(word)).toBe(true);
  // Nothing on the clipboard yet: no Paste.
  expect(labels(app)).toEqual(["Cut", "Copy", "Select All"]);
  await app.chooseMenuItem("Copy");
  expect(app.clipboard()).toBe(word);
  expect(app.menu()).toBe(null);
});

test("the toolbar makes the word a long press selected bold", async () => {
  const app = await openEditor();
  await app.longPress(`text:${FIRST}`);
  const word = selected(app);
  await app.waitFor("text:bold: false");
  await app.press("role:button[Bold]");
  await app.waitFor("text:bold: true");
  // The word's span in the first paragraph (after the line that shows it).
  expect(app.spanStyle(`text:${word} >> nth=1`).fontWeight).toBe(700);
});

test("cut and paste from the edit menu, and undo takes the paste back", async () => {
  const app = await openEditor();
  await app.longPress(`text:${FIRST}`);
  const word = selected(app);
  await app.chooseMenuItem("Cut");
  await app.waitFor(`text:${FIRST}`, { state: "gone" });
  // A tap places the caret; a tap on the caret opens its menu.
  await app.press(`text:${SECOND}`);
  await app.wait(600);
  await app.press(`text:${SECOND}`);
  expect(labels(app)).toEqual(["Paste", "Select All"]);
  await app.chooseMenuItem("Paste");
  await app.waitFor(`text:${SECOND}`, { state: "gone" });
  expect(app.texts().some((t) => t.startsWith("Then") && t.includes(word))).toBe(true);
  await app.press("role:button[Undo]");
  await app.waitFor(`text:${SECOND}`);
});

test("Select All from the menu selects the whole document", async () => {
  const app = await openEditor();
  await app.longPress(`text:${FIRST}`);
  await app.chooseMenuItem("Select All");
  expect(selected(app)).toBe(`${FIRST} ${SECOND}`);
  // Everything is selected: no Select All.
  expect(labels(app)).toEqual(["Cut", "Copy"]);
});
