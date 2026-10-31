// Rich text: the chat's replies and the Text View demo are `TextView`s of
// `nsh/base`, Markdown streamed in as a model writes it.
import { expect, open, test } from "nsh/test";

test("a chat reply streams in as Markdown, with a table and code to copy", async () => {
  const app = await open("../App.tsx", { clock: {} });
  await app.press("label:AI Chat");
  await app.press("Explain list virtualization >> nth=0");
  await app.clock!.runFor(2000);
  expect(app.shows("Rendering a long list")).toBe(true);
  await app.clock!.runFor(30_000);
  expect(app.shows("Windowed list")).toBe(true);
  expect(app.shows("Prefer fixed heights for rows you can predict.")).toBe(true);
  await app.press("label:Copy code");
  expect(app.clipboard()).toContain("<List each={photos()} estimatedItemSize={76}>");
});

test("the Text View demo shows Markdown, HTML and extensions, and streams", async () => {
  const app = await open("../App.tsx", { clock: {} });
  await app.press("label:TextView");
  await app.waitFor("Native Shell");
  // A link is a span of its paragraph, pressed by its characters.
  await app.press("the guide");
  await app.waitFor("text:https://github.com/longbridge/nsh");
  // One document at a time, a tab each.
  await app.press("role:tab[HTML]");
  await app.waitFor("NSH 0.1.0: native UI from TSX");
  expect(app.shows("@huacnlee")).toBe(true);
  await app.press("role:tab[Extensions]");
  await app.waitFor("HEADS UP");
  await app.press("role:tab[Streaming]");
  await app.waitFor("Stream it");
  await app.press("Stream it");
  await app.clock!.runFor(10_000);
  expect(app.shows("That's it. Ping me if anything looks off.")).toBe(true);
});
