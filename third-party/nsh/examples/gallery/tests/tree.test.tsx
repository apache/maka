// The Tree demo: a project explorer the app controls (a press opens a
// folder, a double press or Return opens a file, `revealItem` opens the
// folders above a file, a disabled build folder), a settings sidebar with
// the tree's own state, 10 100 items of which only the rows in view are
// made, and an outline the app locks. Each tree is one Tab stop whose arrow
// keys move the selection.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("../App.tsx", { platform: "macos", width: 1200, height: 1700, clock: {} });
  await app.press("role:button[Tree]");
  await app.waitFor("Selected: app/src/router.rs");
});

test("each tree is a labelled tree of tree items", async () => {
  for (const name of ["Project files", "Settings", "Logs", "Outline"]) expect(app.count(`role:tree[${name}]`)).toBe(1);
  expect(app.count("role:treeitem[router.rs]")).toBe(1);
  // views is collapsed: its files are never made.
  expect(app.count("role:treeitem[inbox.rs]")).toBe(0);
});

test("a press selects a file and opens a folder; the build folder takes none", async () => {
  await app.press("role:treeitem[assets]");
  await app.waitFor("Expanded app/assets");
  await app.waitFor("role:treeitem[logo.svg]");
  await app.press("role:treeitem[logo.svg]");
  await app.waitFor("Selected: app/assets/logo.svg");
  expect(app.enabled("role:treeitem[target]")).toBe(false);
  await app.press("role:treeitem[assets]");
  await app.waitFor("Collapsed app/assets");
});

test("revealItem opens the folders above a file", async () => {
  await app.press("text:Reveal compose.rs");
  await app.waitFor("role:treeitem[compose.rs]");
  await app.waitFor("Expanded app/src/views");
});

test("the arrow keys move the selection and open folders", async () => {
  await app.press("role:treeitem[router.rs]");
  await app.keyboard.press("down");
  await app.waitFor("Selected: app/src/views");
  await app.keyboard.press("right");
  await app.waitFor("role:treeitem[inbox.rs]");
  await app.keyboard.press("right");
  await app.waitFor("Selected: app/src/views/inbox.rs");
  await app.keyboard.press("left");
  await app.waitFor("Selected: app/src/views");
});

test("a double press or Return opens a file; the arrows only select", async () => {
  // A double press on a file opens it.
  await app.press("role:treeitem[main.rs]");
  await app.waitFor("Selected: app/src/main.rs");
  await app.press("role:treeitem[main.rs]");
  await app.waitFor("Opened app/src/main.rs");
  await app.waitFor("Open: main.rs");
  // The arrows select without opening; Return opens the file selected.
  await app.keyboard.press("down");
  await app.waitFor("Selected app/src/router.rs");
  expect(app.shows("Open: main.rs")).toBe(true);
  await app.keyboard.press("enter");
  await app.waitFor("Opened app/src/router.rs");
  await app.waitFor("Open: router.rs");
  // Return on a folder opens it, as a press does.
  await app.keyboard.press("down");
  await app.waitFor("Selected app/src/views");
  await app.keyboard.press("enter");
  await app.waitFor("Expanded app/src/views");
  expect(app.shows("Open: router.rs")).toBe(true);
});

test("the settings sidebar keeps its own state and shows the section chosen", async () => {
  await app.waitFor("Which accounts alert you, and how quietly.");
  await app.press("role:treeitem[Accounts]");
  await app.waitFor("role:treeitem[Work]");
  await app.waitFor("Your mailboxes, their signatures and aliases.");
  expect(app.enabled("role:treeitem[Billing]")).toBe(false);
});

test("a tree of 10 100 items makes only the rows in view", async () => {
  expect(app.count("role:tree[Logs] >> role:treeitem")).toBeLessThan(60);
  await app.press("text:Reveal file-87-42");
  await app.waitFor("role:treeitem[file-87-42.log]");
  await app.waitFor("2 of 100 folders open");
});

test("a locked outline takes no press until the app unlocks it", async () => {
  expect(app.enabled("role:treeitem[Budget]")).toBe(false);
  await app.press("label:Lock");
  await app.press("role:treeitem[Budget]");
  await app.waitFor("Outline q4/budget");
});
