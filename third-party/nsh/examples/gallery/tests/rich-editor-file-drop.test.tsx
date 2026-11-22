import { expect, open, test } from "nsh/test";

const openEditor = () => open("./fixtures/rich-editor-file-drop.tsx", { platform: "macos" });

test("files dropped on a RichEditor reach its onFileDrop, and the document and caret stay", async () => {
  const app = await openEditor();
  await app.press("text:Drop files on the composer");
  await app.waitFor("text:/^caret: \\d+-\\d+ /");
  const before = app.texts().find((t) => t.startsWith("caret: "));
  await app.dropFiles("id:composer", ["file:///tmp/shot%201.png", "file:///tmp/notes.pdf"]);
  await app.waitFor("text:attached: file:///tmp/shot%201.png file:///tmp/notes.pdf [image/png application/pdf]");
  // The editor inserted nothing and kept the caret where it was.
  expect(app.texts().find((t) => t.startsWith("caret: "))).toBe(before);
  expect(app.shows("text:Drop files on the composer")).toBe(true);
});

test("an editor without onFileDrop leaves dropped files to the view around it", async () => {
  const app = await openEditor();
  await app.dropFiles("id:notes", ["file:///tmp/a.txt"]);
  await app.waitFor("text:around: file:///tmp/a.txt");
  expect(app.shows("text:attached: none")).toBe(true);
});
