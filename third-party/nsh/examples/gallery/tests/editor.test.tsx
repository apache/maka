// The Editor demo: `nsh/base`'s `Editor` in a `DockArea` with its problems
// in a bottom dock, a language menu, an options menu (soft wrap, line
// numbers, the problems), the app's find bar, whose inputs pass a `search` and whose
// buttons call the ref, and on the
// TypeScript sample a simulated language server, whose answers the app
// shows as diagnostics, a hover card, a menu of code actions, decorations
// and completions.
import { expect, open, test } from "nsh/test";

test("the Editor demo finds, replaces and switches samples", async () => {
  const app = await open("../App.tsx");
  await app.press("role:button[Editor]");
  // The language menu (a sheet on a phone) chooses the sample.
  await app.press("label:Language");
  await app.press("Rust");
  // The Rust sample, a row per line, with its warning.
  await app.waitFor("fn main() {");
  expect(app.shows("1 warning")).toBe(true);
  expect(app.shows("Ln 1, Col 1")).toBe(true);
  // The find bar is closed until asked for.
  expect(app.shows("label:Find")).toBe(false);
  await app.press("label:Find and replace");
  // "word" in any case, anywhere: in `words` and `word_counts` too.
  await app.type("label:Find", "word");
  await app.waitFor("7 matches");
  // Whole words only, then every one replaced as one edit.
  await app.press("label:Whole word");
  await app.waitFor("4 matches");
  await app.type("label:Replace", "term");
  await app.press("label:Replace all");
  await app.waitFor("Replaced 4");
  await app.waitFor("No results");
  // The close button closes the find bar.
  await app.press("label:Close the find bar");
  await app.waitFor("label:Find", { state: "gone" });
  // Another language's sample, in an editor of its own.
  await app.press("label:Language");
  await app.press("Python");
  await app.waitFor("class Point:");
});

// The language server's features: a desktop (headless, the app runs as
// macOS), wide enough for the full presentation of the area (its problems
// in an open bottom dock, not a sheet) and tall enough for every line of
// the TypeScript sample to be on screen above them.
const desktop = { platform: "macos", width: 1200, height: 2400 } as const;

test("the server's diagnostics are marked, counted and listed", async () => {
  const app = await open("../App.tsx", desktop);
  await app.press("role:button[Editor]");
  await app.waitFor("receipt.prnt();");
  // A misspelled method, two unused variables, a `var`, a loose `==` and
  // a TODO.
  await app.waitFor("1 error");
  expect(app.shows("4 warnings")).toBe(true);
  expect(app.shows("1 info")).toBe(true);
  // The color literals are tinted with their colors.
  expect(app.spanStyle("text:#ff8800")?.backgroundColor).toBe("#ff880040");
  // A problem of the list puts the caret on it.
  await app.press("label:Property 'prnt' does not exist on type 'Receipt'. Did you mean 'print'?");
  await app.waitFor("Ln 57, Col 9");
});

test("a quick fix from the code actions at the caret", async () => {
  const app = await open("../App.tsx", desktop);
  await app.press("role:button[Editor]");
  await app.waitFor("4 warnings");
  await app.press("text:var total = subtotal(order);");
  // The editor's own Mod+. asks the app (`onCodeActionRequest`).
  await app.keyboard.press("mod+.");
  await app.waitUntil(() => app.menu() !== null);
  const labels = app.menu()!.map((item) => item.label);
  expect(labels).toContain("Replace 'var' with 'let'");
  expect(labels).toContain("Toggle Line Comment");
  await app.chooseMenuItem("Replace 'var' with 'const'");
  await app.waitFor("text:const total = subtotal(order);");
  // The linter runs again once typing pauses: one warning less.
  await app.waitFor("3 warnings");
  // The fix was one edit: one undo takes it back.
  await app.keyboard.press("mod+z");
  await app.waitFor("text:var total = subtotal(order);");
});

test("hovering a name shows its signature and docs", async () => {
  const app = await open("../App.tsx", desktop);
  await app.press("role:button[Editor]");
  await app.waitFor("4 warnings");
  // The middle of the line is in `describe`.
  await app.hover("text:const label = describe(order);");
  await app.waitFor("text:The order's number and what it costs, coupon taken off.");
  expect(app.shows("id:hover-card")).toBe(true);
  // Another word shows its own: the middle of the line is in `add`.
  await app.hover("text:receipt.add(label);");
  await app.waitFor("text:Adds a line at the end.");
  // Leaving the editor closes it.
  await app.hover("label:Editor options");
  await app.waitFor("id:hover-card", { state: "gone" });
});

test("go to definition moves to the declaration", async () => {
  const app = await open("../App.tsx", desktop);
  await app.press("role:button[Editor]");
  await app.waitFor("4 warnings");
  await app.press("text:const label = describe(order);");
  // The editor's own F12 asks the app (`onDefinitionRequest`, trigger
  // `key`).
  await app.keyboard.press("f12");
  await app.waitFor("Definition of describe at 47:10");
  expect(app.shows("Ln 47, Col 10")).toBe(true);
});

// Completion and inline completion: the editor asks (`onCompletionRequest`,
// `onInlineCompletionRequest`), the server answers later and the ref
// presents the answer.
test("completions as you type, after a dot and on Ctrl+Space", async () => {
  const app = await open("../App.tsx", desktop);
  await app.press("role:button[Editor]");
  await app.waitFor("4 warnings");
  // At the end of the file.
  await app.press("text:receipt.prnt();");
  await app.keyboard.press("mod+down");
  for (const key of ["r", "e", "c"]) await app.keyboard.press(key);
  await app.waitFor("text:receipt");
  await app.keyboard.press("enter");
  await app.waitFor("Completed receipt");
  // A dot asks for the members of `Receipt`.
  await app.keyboard.press(".");
  await app.waitFor("text:print");
  expect(app.shows("text:add")).toBe(true);
  await app.keyboard.press("escape");
  await app.waitFor("text:print", { state: "gone" });
  // Ctrl+Space asks again where the caret is.
  await app.keyboard.press("ctrl+space");
  await app.waitFor("text:print");
});

test("inline completion suggests the rest of the line, taken with Tab", async () => {
  const app = await open("../App.tsx", desktop);
  await app.press("role:button[Editor]");
  await app.waitFor("4 warnings");
  await app.press("text:receipt.prnt();");
  await app.keyboard.press("mod+down");
  for (const key of ["i", "f", "space"]) await app.keyboard.press(key);
  await app.wait(400);
  await app.keyboard.press("tab");
  await app.waitFor('text:if (order.coupon === "SAVE10") {');
});

test("Mod+F opens the find bar, Escape closes it", async () => {
  const app = await open("../App.tsx", desktop);
  await app.press("role:button[Editor]");
  await app.waitFor("4 warnings");
  await app.press("text:const label = describe(order);");
  await app.keyboard.press("mod+f");
  await app.waitFor("label:Find");
  await app.type("label:Find", "order");
  await app.waitFor("text:/^\\d+ (of \\d+|matches)$/");
  await app.keyboard.press("escape");
  await app.waitFor("label:Find", { state: "gone" });
});

test("the options menu switches soft wrap, and the problems' dock hides", async () => {
  const app = await open("../App.tsx", desktop);
  await app.press("role:button[Editor]");
  await app.waitFor("4 warnings");
  const prnt = "label:Property 'prnt' does not exist on type 'Receipt'. Did you mean 'print'?";
  expect(app.shows(prnt)).toBe(true);
  // The status line's button toggles the dock.
  await app.press("label:Toggle problems");
  await app.waitFor(prnt, { state: "gone" });
  await app.press("label:Toggle problems");
  await app.waitFor(prnt);
  // Soft wrap keeps the menu open; Problems closes it and hides the dock.
  await app.press("label:Editor options");
  await app.press("Soft wrap");
  await app.press("Problems");
  await app.waitFor(prnt, { state: "gone" });
});
