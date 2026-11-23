// Run with `nsh test crates/nsh-platform-ios/tests/selection --target ios`.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";
import type { Bounds } from "nsh";

function selection(app: App): { text: string; start: number; bounds: Bounds; pageBounds: Bounds } {
  return JSON.parse(app.texts().find((t) => t.startsWith("Selection: "))!.slice(11));
}

async function toolbarFollows(app: App) {
  await app.waitUntil(() => {
    const line = app.texts().find((t) => t.startsWith("Toolbar: {"));
    if (!line) return false;
    const bar: Bounds = JSON.parse(line.slice(9));
    return Math.round(bar.origin.y + bar.size.height + 8) === Math.round(selection(app).pageBounds.origin.y);
  });
}

test("word and multi-line selections report bounds and anchor a toolbar", async () => {
  const app = await open("./App.tsx");
  await app.longPress("text:Alpha beta gamma");
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("Selection: {") && t.includes('"pageBounds"')));
  const word = selection(app);
  expect(word.text.length > 0).toBe(true);
  expect(word.bounds.size.width > 0).toBe(true);
  expect(word.bounds.size.height > 0).toBe(true);
  expect(Math.round(word.pageBounds.origin.x - word.bounds.origin.x)).toBe(46);
  await toolbarFollows(app);
  await app.keyboard.press("mod+a");
  await app.waitUntil(() => selection(app).text === "Alpha beta gamma\nDelta epsilon");
  expect(selection(app).bounds.size.height > word.bounds.size.height).toBe(true);
  await toolbarFollows(app);
});

for (const scroll of ["inner", "outer"]) {
  test(`the unchanged selection and its toolbar follow ${scroll} scrolling`, async () => {
    const app = await open("./App.tsx");
    await app.longPress("text:Alpha beta gamma");
    await app.waitUntil(() => app.texts().some((t) => t.startsWith("Selection: {") && t.includes('"pageBounds"')));
    const before = selection(app);
    // The long press leaves the edit menu up. UIKit places it above or below
    // the selection (iOS 27 below, over the inner view's middle, where
    // `app.scroll` puts the finger), and a finger on the menu scrolls
    // nothing: the inner view is dragged from a place the menu never covers.
    // The drag is short, as short as a tap's movement: scrolling still keeps
    // the selection.
    if (scroll === "inner") await app.drag("id:inner-grip", { x: 0, y: -20 });
    else await app.scroll(`id:${scroll}`, 20);
    await app.waitUntil(() => selection(app).pageBounds.origin.y < before.pageBounds.origin.y);
    const after = selection(app);
    expect(after.text).toBe(before.text);
    expect(after.start).toBe(before.start);
    expect(after.bounds.size).toEqual(before.bounds.size);
    if (scroll === "outer") expect(after.bounds).toEqual(before.bounds);
    else expect(after.bounds.origin.y < before.bounds.origin.y).toBe(true);
    await toolbarFollows(app);
  });
}

test("a tap beside the selection clears it", async () => {
  const app = await open("./App.tsx");
  await app.longPress("text:Alpha beta gamma");
  await app.waitUntil(() => selection(app).text.length > 0);
  // A finger that lands and lifts without moving: the area hears no presses.
  await app.drag("text:Delta epsilon", { x: 0, y: 0 });
  await app.waitUntil(() => selection(app).text === "");
});

test("a long press on selectable text opens the edit menu, and the selection copies", async () => {
  const app = await open("./App.tsx");
  // The press selects a word and UIKit builds its edit menu, asking the
  // text for positions and ranges around the selection.
  await app.longPress("text:Copy this sentence");
  await app.wait(1000);
  await app.keyboard.press("mod+a");
  await app.keyboard.press("mod+c");
  // Read back through the system pasteboard: a paste into an input.
  await app.clear("id:paste");
  await app.keyboard.press("mod+v");
  await app.waitUntil(() => app.value("id:paste") === "Copy this sentence");
});
