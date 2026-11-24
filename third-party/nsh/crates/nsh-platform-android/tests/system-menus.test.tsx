// Run with --target android: the menus are PopupWindows of their own, which
// the test agent chooses from and closes as a finger and the back button do.
import { expect, open, test } from "nsh/test";

test("a menu button's system menu is chosen from, a submenu's item too", async () => {
  const app = await open("./SystemMenus.tsx");
  await app.press("id:menu-button");
  await app.chooseMenuItem("Share");
  await app.waitFor("text:last:button:share");
  await app.press("id:menu-button");
  await app.chooseMenuItem("Move to > Archive");
  await app.waitFor("text:last:button:move:archive");
});

test("a context menu's system menu is chosen from", async () => {
  const app = await open("./SystemMenus.tsx");
  await app.longPress("id:note");
  await app.chooseMenuItem("Star");
  await app.waitFor("text:last:context:star");
});

test("a system menu closes with nothing chosen", async () => {
  const app = await open("./SystemMenus.tsx");
  await app.press("id:menu-button");
  await app.closeMenu();
  expect(app.shows("text:last:none")).toBe(true);
  await expect(app.closeMenu()).rejects.toThrow("no context menu is open");
});

test("a missing or disabled item is refused", async () => {
  const app = await open("./SystemMenus.tsx");
  await app.press("id:menu-button");
  await expect(app.chooseMenuItem("Rename")).rejects.toThrow(
    'the menu has no item "Rename"; it shows: Share, Move to, Locked',
  );
  await expect(app.chooseMenuItem("Locked")).rejects.toThrow("the menu stays open after it was chosen");
  await app.closeMenu();
  expect(app.shows("text:last:none")).toBe(true);
});
