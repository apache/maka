// UIKit regression: run this directory with `nsh test --target ios`. A menu
// button's menu grows out of the trigger the app drew (a floating glass
// pill, a bordered button), which UIKit hides while the menu is up and
// shows again once it goes: the menu stays chosen from, and the trigger
// opens it again. Whether the trigger shows through the menu's glass is
// seen in a simulator screenshot taken while the menu is open.
import { expect, open, test } from "nsh/test";

test("a drawn trigger's menu is chosen from and opens again once it went", async () => {
  const app = await open("./App.tsx");
  await app.press("id:pill");
  await app.chooseMenuItem("Create in chat");
  await app.waitFor("text:last:pill:chat");
  await app.press("id:pill");
  await app.closeMenu();
  await app.press("id:pill");
  await app.chooseMenuItem("Create with form");
  await app.waitFor("text:last:pill:form");
});

test("a bordered trigger's menu is chosen from as before", async () => {
  const app = await open("./App.tsx");
  await app.press("id:plain");
  await app.chooseMenuItem("By date");
  await app.waitFor("text:last:plain:date");
  expect(app.shows("id:pill")).toBe(true);
});
