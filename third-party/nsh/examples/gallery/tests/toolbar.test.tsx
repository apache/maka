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
