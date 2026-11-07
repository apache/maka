// The Toolbar demo: a text editor's formatting bar whose history undoes
// and redoes the marks, a block menu and a link popover opened from it, a
// media player's transport, a vertical palette of tools, and a review bar
// the app locks. Each bar is a toolbar for screen readers, its runs named
// groups.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("../App.tsx", { platform: "macos", width: 1200, height: 1700, clock: {} });
  await app.press("role:button[Toolbar]");
  await app.waitFor("Text formatting");
});

test("each bar is a labelled toolbar; a toggle group inside one is a group of it", async () => {
  for (const name of ["Formatting", "Playback", "Tools", "Review"]) expect(app.count(`role:toolbar[${name}]`)).toBe(1);
  expect(app.count("role:group[History]")).toBe(1);
  expect(app.count("role:group[Transport]")).toBe(1);
});

test("marks press, and the history undoes and redoes them", async () => {
  expect(app.enabled("label:Undo")).toBe(false);
  await app.press("label:Italic");
  await app.waitFor("Italic: on");
  await app.waitFor("1 edits");
  expect(app.enabled("label:Undo")).toBe(true);
  await app.press("label:Undo");
  await app.waitFor("Undo");
  await app.waitFor("0 edits");
  expect(app.enabled("label:Redo")).toBe(true);
  await app.press("label:Redo");
  await app.waitFor("Redo");
  await app.waitFor("1 edits");
});

test("the block menu and the link popover open from the toolbar", async () => {
  await app.press("label:Block: Paragraph");
  await app.press("text:Heading");
  await app.waitFor("Block: Heading");
  await app.press("role:toolbar[Formatting] >> label:Link");
  await app.type("label:Link address", "https://nsh.dev");
  await app.submit("label:Link address");
  await app.waitFor("Link: https://nsh.dev");
});

test("the arrows walk the formatting bar in the tree's order, the block menu's trigger among its items", async () => {
  // Undo and Redo are disabled, so Tab enters at the block menu's trigger and Right reaches Bold. A popup's trigger
  // renders after the toolbar's later items: in the order items came, Tab would enter at Bold and Right would reach
  // Italic. Space presses the item the focus is on. (Where Tab starts is the platform's: Tab on to the bar.)
  let tabs = 0;
  while (!app.shows("Bold: off")) {
    expect(++tabs).toBeLessThan(10);
    await app.keyboard.press("tab");
    await app.keyboard.press("right");
    await app.keyboard.press("space");
    await app.wait(50);
  }
  await app.keyboard.press("right");
  await app.keyboard.press("space");
  await app.waitFor("Italic: on");
  await app.waitFor("2 edits");
  // Italic → Bold → the block menu's trigger → Undo (enabled now; Redo still disabled, skipped).
  for (let i = 0; i < 3; i++) await app.keyboard.press("left");
  await app.keyboard.press("space");
  await app.waitFor("1 edits");
  // Redo is enabled now, right after Undo.
  await app.keyboard.press("right");
  await app.keyboard.press("space");
  await app.waitFor("2 edits");
  // Home is Undo, the first enabled item.
  await app.keyboard.press("home");
  await app.keyboard.press("space");
  await app.waitFor("1 edits");
  // End is the overflow menu's trigger, the last item: Space opens it.
  await app.keyboard.press("end");
  await app.keyboard.press("space");
  await app.press("text:Copy as Markdown");
  await app.waitFor("Copied as Markdown");
});

test("on a phone the formatting bar folds what has no room into its overflow menu, which stays in reach", async () => {
  const phone = await open("../App.tsx", { clock: {} });
  await phone.press("role:button[Toolbar]");
  await phone.waitFor("Text formatting");
  // A 324-point bar: the alignment, Strikethrough, Underline and Redo fold; the rest stays.
  await phone.waitFor("1 marks · left · 4 in ⋯");
  const bar = "role:toolbar[Formatting]";
  for (const label of ["Undo", "Block: Paragraph", "Bold", "Italic", "Link", "More formatting"]) expect(phone.count(`${bar} >> label:${label}`)).toBe(1);
  for (const label of ["Redo", "Underline", "Strikethrough", "Align left"]) expect(phone.count(`${bar} >> label:${label}`)).toBe(0);
  // The folded marks are check items of the menu.
  await phone.press(`${bar} >> label:More formatting`);
  await phone.press("text:Underline");
  await phone.waitFor("2 marks · left · 4 in ⋯");
});

test("the transport plays and skips, and the palette picks one tool", async () => {
  await app.press("label:Play");
  await app.waitFor("Play: Night Drive");
  await app.press("label:Next");
  await app.waitFor("Next: Paper Lanterns");
  await app.press("label:Pause");
  await app.waitFor("Pause");
  await app.press("label:Pen");
  await app.waitFor("Tool: Pen");
  await app.waitFor("Draw freehand strokes");
  expect(app.enabled("label:Eraser")).toBe(false);
});

test("a locked bar disables every item in it, its link included", async () => {
  expect(app.enabled("label:Approve")).toBe(true);
  expect(app.enabled("label:Share (needs edit access)")).toBe(false);
  await app.press("label:Lock");
  await app.waitFor("Locked: no presses, no Tab stop, dimmed for screen readers");
  for (const label of ["Approve", "Show comments"]) expect(app.enabled(`label:${label}`)).toBe(false);
  expect(app.enabled("role:link[Review guide]")).toBe(false);
  await app.press("label:Lock");
  await app.press("label:Approve");
  await app.waitFor("Approved");
});
