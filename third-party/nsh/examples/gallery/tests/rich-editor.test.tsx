// The Rich Editor demo: `nsh/base`'s `RichEditor` on Tiptap's extensions,
// a toolbar whose buttons run commands on the session the editor shows, a
// bubble menu for links and a zoom.
import { expect, open, test } from "nsh/test";

const ITEM = "Tab indents an item, Shift-Tab outdents it";
const DETAILS = "Drag to select past the editor's edge and the document scrolls along. The zoom button in the toolbar gives the editor the whole screen.";
const LINKS = "Links open a menu under the caret: read the NSH documentation, edit it, or remove it. Select text and press Mod-K to link it.";

async function openDemo() {
  const app = await open("../App.tsx");
  await app.press("role:button[RichEditor]");
  await app.waitFor(ITEM);
  return app;
}

test("Tab and Shift-Tab indent list items, and the toolbar edits the shown editor", async () => {
  const app = await openDemo();
  // The caret in the second item: Tab nests it (and its own items, a level
  // deeper) under the first.
  await app.press(ITEM);
  await app.keyboard.press("tab");
  await app.waitFor("▪");
  // Shift-Tab takes it back out.
  await app.keyboard.press("shift+tab");
  await app.waitFor("▪", { state: "gone" });
  // A toolbar button runs a command while the editor is shown: the view
  // follows the session's new state.
  await app.keyboard.press("tab");
  await app.waitFor("▪");
  await app.press("role:button[Undo]");
  await app.waitFor("▪", { state: "gone" });
  expect(app.shows(ITEM)).toBe(true);
});

test("the list buttons change every level of a nested list, and take it out", async () => {
  const app = await openDemo();
  // Counted against what was on screen before: how much of the document
  // fits (and with it how many of its other numbered lists show) depends
  // on the fonts' metrics.
  const numbered = app.count("text:1.");
  const lettered = app.count("text:a.");
  await app.press("The list buttons change every level at once");
  await app.press("role:button[Numbered list]");
  await app.waitFor("text:•", { state: "gone" });
  // The outer list and the nested one are numbered, the nested one with
  // letters.
  expect(app.count("text:◦")).toBe(0);
  expect(app.count("text:1.")).toBe(numbered + 1);
  expect(app.count("text:a.")).toBe(lettered + 1);
  await app.press("role:button[Bulleted list]");
  await app.waitFor("text:◦");
  expect(app.count("text:•")).toBe(2);
  // The same kind again: the item leaves every list.
  await app.press("role:button[Bulleted list]");
  await app.waitFor("text:◦", { state: "gone" });
});

test("the link under the caret shows a menu that edits and removes it", async () => {
  const app = await openDemo();
  await app.press(LINKS);
  await app.keyboard.press("home");
  // Into "NSH documentation".
  for (let i = 0; i < 46; i++) await app.keyboard.press("right");
  await app.waitFor("role:button[Edit link]");
  expect(app.shows("text:https://github.com/longbridge/nsh")).toBe(true);
  await app.press("role:button[Edit link]");
  expect(app.value("label:Link address")).toBe("https://github.com/longbridge/nsh");
  await app.clear("label:Link address");
  await app.type("label:Link address", "https://nsh.dev");
  await app.submit("label:Link address");
  await app.waitFor("text:https://nsh.dev");
  await app.press("role:button[Remove link]");
  await app.waitFor("role:button[Edit link]", { state: "gone" });
});

test("the zoom gives the editor the whole window, and the document stays", async () => {
  const app = await openDemo();
  await app.press(ITEM);
  await app.keyboard.press("tab");
  await app.waitFor("▪");
  await app.press("role:button[Zoom]");
  await app.waitFor("role:button[Exit zoom]");
  // The same session: the edit made before is there.
  expect(app.count("text:▪")).toBe(2);
  await app.press("role:button[Exit zoom]");
  await app.waitFor("role:button[Zoom]");
  expect(app.count("text:▪")).toBe(2);
});

test("Backspace after the caret moves deletes one character", async () => {
  const app = await openDemo();
  await app.press(ITEM);
  await app.keyboard.press("home");
  for (let i = 0; i < 3; i++) await app.keyboard.press("right");
  await app.keyboard.press("backspace");
  await app.waitFor("Ta indents an item, Shift-Tab outdents it");
});

/** The words the line under the editor counts. */
function words(app: { texts(): string[] }): number {
  const line = app.texts().find((t) => /^\d+ words · \d+ characters$/.test(t)) ?? "";
  return Number(line.split(" ")[0]);
}

test("HTML copied from a page keeps its formatting when pasted", async () => {
  const app = await openDemo();
  await app.press(ITEM);
  const before = words(app);
  // As a browser copies a selection: plain text and the same as HTML.
  await app.paste("label:Document", {
    text: "Pasted title\nSome strong words",
    html:
      '<meta charset="utf-8"><h2>Pasted title</h2>' +
      '<p>Some <span style="font-weight: 700">strong</span> <em>words</em></p>',
  });
  // The heading's text joins the item the caret is in (an open slice), the
  // paragraph is a block of its own; marks keep their formatting.
  // Four words more: "Pasted title" and "Some strong words", whose last
  // joins the word after the caret.
  await app.waitFor(`text:/^${before + 4} words · /`);
  const texts = app.texts();
  expect(texts.some((t) => t.endsWith("Pasted title"))).toBe(true);
  expect(texts.some((t) => t.startsWith("Some strong words"))).toBe(true);
  expect(app.spanStyle("text:strong").fontWeight).toBe(700);
  expect(app.spanStyle("text:Some strong").fontWeight).toBe(400);
  expect(app.spanStyle("text:words >> nth=0").italic).toBe(true);
});

test("a table inserted from the toolbar takes text, Tab moves between its cells, and rows are added", async () => {
  const app = await openDemo();
  await app.press(DETAILS);
  await app.press("role:button[Insert table]");
  // The table's buttons show while the selection is in it.
  await app.waitFor("role:button[Add row after]");
  await app.type("label:Document", "Plan");
  await app.waitFor("Plan");
  await app.keyboard.press("tab");
  await app.type("label:Document", "Done");
  await app.waitFor("Done");
  await app.press("role:button[Add row after]");
  // As Markdown: the new table's header row, its two rows and the one added.
  await app.press("text:Markdown");
  await app.waitFor("id:markdown-source");
  const source = app.texts().find((t) => t.startsWith("# Release notes")) ?? "";
  expect(/\|\s*Plan\s*\|\s*Done\s*\|/.test(source)).toBe(true);
  // The document's own table (four lines) and the new one (five).
  expect(source.split("\n").filter((line) => line.startsWith("|")).length).toBe(9);
});
