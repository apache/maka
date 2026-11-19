// UIKit regression: run this directory with `nsh test --target ios`. What
// UIKit draws for the app outside its views (bar buttons, system menus) is
// pressed and chosen from as a user does, and going back in a sheet that
// holds a stack pops its page before it closes the sheet.
import { expect, open, test } from "nsh/test";

test("a header bar button is pressed by its key and by its label", async () => {
  const app = await open("./App.tsx");
  await app.press("id:add");
  await app.waitFor("text:presses:1");
  await app.press("label:Add item");
  await app.waitFor("text:presses:2");
});

test("a header bar button's menu opens and its items are chosen", async () => {
  const app = await open("./App.tsx");
  await app.press("id:more");
  await app.chooseMenuItem("Rename");
  await app.waitFor("text:last:bar:rename");
  await app.press("id:more");
  await app.chooseMenuItem("Sort > By name");
  await app.waitFor("text:last:bar:sort-name");
  await app.press("id:more");
  await app.closeMenu();
  expect(app.shows("text:last:bar:sort-name")).toBe(true);
});

test("a menu button's system menu is chosen from", async () => {
  const app = await open("./App.tsx");
  await app.press("id:menu-button");
  await app.chooseMenuItem("Share");
  await app.waitFor("text:last:button:share");
  await app.press("id:menu-button");
  await app.chooseMenuItem("Move to > Archive");
  await app.waitFor("text:last:button:move:archive");
});

test("a context menu's system menu is chosen from", async () => {
  const app = await open("./App.tsx");
  await app.longPress("id:note");
  await app.chooseMenuItem("Star");
  await app.waitFor("text:last:context:star");
});

test("going back in a sheet pops its pushed page, then closes it", async () => {
  const app = await open("./App.tsx");
  await app.press("id:open-sheet");
  await app.waitFor("text:Sheet page: Sheet root");
  await app.press("id:push");
  await app.waitFor("text:Sheet page: Detail");
  await app.back();
  await app.waitFor("text:Sheet page: Sheet root");
  expect(app.shows("text:Sheet page: Detail")).toBe(false);
  await app.back();
  await app.waitFor("text:Sheet page: Sheet root", { state: "gone" });
});
