// An extension's node view (`addNodeView`): the app's component renders a
// stock tag, follows its node and selection, and changes and deletes it
// through the editor, one undoable change each.
import { expect, open, test } from "nsh/test";

test("a node view follows its node in place and edits it", async () => {
  const app = await open("./fixtures/rich-editor-node-view.tsx");
  await app.waitFor("text:Tag AAPL of stock in NASDAQ");
  expect(app.shows("text:mounts: 1 pressed at: null")).toBe(true);

  // Typing before the tag moves it: no JS runs for it, its position follows.
  await app.press("id:type");
  await app.waitFor("text:doc: Hey Buy  now tags 1");
  await app.press("id:stock");
  await app.waitFor("text:Tag AAPLX of stock in NASDAQ");
  expect(app.shows("text:mounts: 1 pressed at: 9")).toBe(true);

  await app.press("id:select");
  await app.waitFor("text:Tag AAPLX selected of stock in NASDAQ");
  expect(app.shows("text:mounts: 1 pressed at: 9")).toBe(true);

  // Deleting is one change: undo brings the tag back.
  await app.press("id:delete");
  await app.waitFor("text:doc: Hey Buy  now tags 0");
  expect(app.shows("text:Tag AAPLX selected of stock in NASDAQ")).toBe(false);
  await app.press("id:undo");
  await app.waitFor("text:doc: Hey Buy  now tags 1");
  await app.waitFor("text:Tag AAPLX selected of stock in NASDAQ");
});
