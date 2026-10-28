// The Menus demo on a phone (headless runs are touch screens): a menu bar
// whose menus are sheets, submenus three levels deep in place of their
// items, checkable items and a choice of one that keep the menu open,
// undo and redo following what was done, row menus that change the list,
// a scrolling menu, a menu the app opens.
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

test("checkable items and a choice of one keep the menu open", async () => {
  await app.press("View");
  await app.press("Status bar");
  await app.press("Large");
  await app.waitFor("Sidebar on · status bar on · zoom Large");
  expect(app.texts()).toContain("Medium");
  await app.back();
  expect(app.texts()).not.toContain("Medium");
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
