// Presses on node views (`addNodeView`): one on a view's own area selects
// its node, inline views (on their text, where the text engine placed
// them) as block ones; a button inside a view keeps its press, and the
// selection stays where it was.
import { expect, open, test } from "nsh/test";

const openEditor = async () => {
  const app = await open("./fixtures/rich-editor-node-view-press.tsx");
  await app.waitFor("text:Card 42");
  // The caret at the end of the last paragraph.
  await app.press("text:/^End/");
  await app.keyboard.press("end");
  await app.waitFor("text:selection: text 16");
  return app;
};

test("a press on an inline view's text selects its node", async () => {
  const app = await openEditor();
  await app.press("text:Tag AAPL");
  await app.waitFor("text:selection: node 5");
  await app.waitFor("text:Tag AAPL selected");
  // The editor has the keyboard: the arrow leaves the node.
  await app.keyboard.press("right");
  await app.waitFor("text:selection: text 6");
});

test("a press on a block view's own area selects its node", async () => {
  const app = await openEditor();
  await app.press("text:Card 42");
  await app.waitFor("text:selection: node 11");
  await app.waitFor("text:Card 42 selected");
});

test("a button inside a view keeps its press", async () => {
  const app = await openEditor();
  await app.press("id:card-button");
  await app.waitFor("text:pressed: card button");
  await app.press("id:tag-button");
  await app.waitFor("text:pressed: tag button");
  expect(app.shows("text:selection: text 16")).toBe(true);
  expect(app.shows("text:Tag AAPL selected")).toBe(false);
});
