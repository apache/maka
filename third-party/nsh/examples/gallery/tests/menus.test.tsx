// The Menus demo on a phone (headless runs are touch screens): a menu bar
// whose menus are sheets, submenus three levels deep in place of their
// items, checkable settings that keep the menu open and choices of one that
// close it (or keep a submenu open), a row's checkable item,
// undo and redo following what was done, row menus that change the list,
// a scrolling menu, a menu the app opens, a command whose toast reports it.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("../App.tsx", { clock: {} });
  await app.press("role:button[Menu]");
  await app.waitFor("Menu bar");
});

test("submenus three levels deep take the place of the items", async () => {
  await app.press("File");
  await app.waitFor("New document");
  await app.press("Export as");
  await app.waitFor("PDF");
  expect(app.texts()).not.toContain("New document");
  await app.press("Image");
  await app.waitFor("WebP");
  expect(app.texts()).not.toContain("PDF");
  await app.back();
  await app.waitFor("PDF");
  await app.press("Image");
  await app.press("PNG");
  await app.waitFor("Done: Export PNG");
  expect(app.texts()).not.toContain("WebP");
});

test("undo and redo follow what was done", async () => {
  await app.press("File");
  await app.press("Save");
  await app.waitFor("Done: Save");
  await app.press("Edit");
  await app.press("Undo Save");
  await app.waitFor("Nothing done yet");
  await app.press("Edit");
  await app.press("Redo Save");
  await app.waitFor("Done: Save");
});

test("settings are checkable items that keep the menu open", async () => {
  await app.press("View");
  await app.waitFor("Show sidebar");
  expect(app.count("role:menuitemcheckbox")).toBe(2);
  expect(app.count("role:menuitemradio")).toBe(3);
  await app.press("Show minimap");
  await app.waitFor("Sidebar on · minimap on · by Name · zoom Medium");
  await app.press("Show sidebar");
  await app.waitFor("Sidebar off · minimap on · by Name · zoom Medium");
  expect(app.texts()).toContain("Show sidebar");
  await app.back();
  expect(app.texts()).not.toContain("Show sidebar");
});

test("a choice of one closes the menu and reorders the preview", async () => {
  await app.press("View");
  await app.press("Size");
  await app.waitFor("Sidebar on · minimap off · by Size · zoom Medium");
  expect(app.texts()).not.toContain("Show sidebar");
  // The largest file first.
  const files = app.texts().filter((t) => ["main.rs", "Cargo.toml", "README.md", "lib.rs"].includes(t));
  expect(files[0]).toBe("lib.rs");
});

test("a choice of one in a submenu keeps it open", async () => {
  await app.press("View");
  await app.press("Zoom");
  await app.waitFor("Large");
  await app.press("Large");
  await app.waitFor("Sidebar on · minimap off · by Name · zoom Large");
  expect(app.texts()).toContain("Medium");
});

test("a row's context menu has a checkable item that closes it", async () => {
  await app.longPress("Notes.txt");
  await app.waitFor("Starred");
  expect(app.count("role:menuitemcheckbox[Starred]")).toBe(1);
  await app.press("Starred");
  expect(app.texts()).not.toContain("Duplicate");
});

test("a row's menu changes the list", async () => {
  await app.press("label:Actions for Notes.txt");
  await app.press("Duplicate");
  await app.waitFor("Notes copy.txt");
  await app.longPress("Holiday.jpg");
  await app.press("Delete");
  await app.waitFor("Notes copy.txt");
  expect(app.texts()).not.toContain("Holiday.jpg");
});

test("the placement and alignment change the menu's trigger", async () => {
  await app.press("Top");
  await app.press("End");
  await app.waitFor("top · end");
  await app.press("top · end");
  await app.waitFor("Three");
});

test("a long menu scrolls, and the app opens a menu itself", async () => {
  await app.press("UTC+8 Hong Kong");
  await app.waitFor("UTC−10 Honolulu");
  await app.press("UTC+9 Tokyo");
  await app.waitFor("UTC+9 Tokyo");
  expect(app.texts()).not.toContain("UTC−10 Honolulu");
  await app.press("Open the commands");
  await app.waitFor("Sync now");
  await app.press("Sync now");
  await app.waitFor("ran Sync now");
});

test("a command that takes a while shows a toast that becomes its result", async () => {
  await app.press("Open the commands");
  await app.press("Sync now");
  await app.waitFor("Syncing…");
  await app.wait(1300);
  await app.waitFor("Up to date");
});
