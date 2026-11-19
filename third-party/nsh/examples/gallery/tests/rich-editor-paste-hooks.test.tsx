// A paste through the app's hooks on a `RichEditorPlugin`
// (`transformPasted` and `handlePaste`, ProseMirror's paste props): they
// run in turn, the content goes in once they answered, a paste the
// document changed under starts over, and pastes go in in order.
import { open, test } from "nsh/test";

const openEditor = async () => {
  const app = await open("./fixtures/rich-editor-paste-hooks.tsx");
  await app.waitFor("text:doc: paragraph");
  return app;
};

test("transformPasted changes the content before it goes in", async () => {
  const app = await openEditor();
  await app.paste("id:editor", { text: "plain words" });
  await app.waitFor("text:PLAIN WORDS");
  await app.waitFor("text:log: transform handle");
});

test("handlePaste reads the clipboard's HTML and inserts itself", async () => {
  const app = await openEditor();
  await app.paste("id:editor", {
    text: "· One\n· Two",
    html: '<p class="MsoListParagraph">· One</p><p class="MsoListParagraph">· Two</p>',
  });
  await app.waitFor("text:/^doc: bulletList/");
  await app.waitFor("text:One");
  await app.waitFor("text:Two");
});

test("a video link pasted on its own is the app's to insert", async () => {
  const app = await openEditor();
  await app.paste("id:editor", { text: "https://www.youtube.com/watch?v=abc" });
  await app.waitFor("text:/video https:\\/\\/www\\.youtube\\.com\\/watch\\?v=abc/");
});

test("handlePaste pastes HTML it cleaned up as a paste with pasteHTML", async () => {
  const app = await openEditor();
  await app.paste("id:editor", {
    text: "Shot cap",
    html: '<b id="docs-internal-guid-1"><figure data-src="https://example.com/a.png"><figcaption>Shot cap</figcaption></figure></b>',
  });
  // Read by the paste's rules, the figure stays one around its caption;
  // the hooks are not asked again: the caption is not upper-cased and
  // the log has one handle.
  await app.waitFor("text:/^doc: (paragraph,)?figure https:\\/\\/example\\.com\\/a\\.png/");
  await app.waitFor("text:Shot cap");
  await app.waitFor("text:log: transform handle");
});

test("handlePaste pastes text with pasteText", async () => {
  const app = await openEditor();
  await app.paste("id:editor", { text: "plain:one\ntwo" });
  await app.waitFor("text:doc: paragraph,paragraph");
  await app.waitFor("text:one");
  await app.waitFor("text:two");
  await app.waitFor("text:log: transform handle");
});

test("a paste the document changed under starts over at the new selection", async () => {
  const app = await openEditor();
  await app.press("id:change-once");
  await app.paste("id:editor", { text: "pasted" });
  // The first transform changed the document: the paste ran again.
  await app.waitFor("text:log: transform transform handle");
  await app.waitFor("text:typed PASTED");
});

test("pastes go in in the order they were made", async () => {
  const app = await openEditor();
  await app.paste("id:editor", { text: "one " });
  await app.paste("id:editor", { text: "two" });
  await app.waitFor("text:ONE TWO");
});
