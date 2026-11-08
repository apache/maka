// A context menu's trigger is pressed like any view: a tap presses it and
// opens no menu, on every platform. In the browser, Shift+F10 on the
// focused trigger opens it with the keyboard focus on its first item.
import { expect, open, test } from "nsh/test";

test("a tap presses the trigger of a context menu", async () => {
  const app = await open("./fixtures/context-menu.tsx");
  await app.press("text:solo");
  await app.waitFor("text:tapped: solo");
  await app.wait(800);
  expect(app.menu()).toBe(null);
});

test("a held finger opens the menu over the trigger's press", async () => {
  const app = await open("./fixtures/context-menu.tsx");
  await app.longPress("text:solo");
  await app.press("text:menu-solo");
  await app.waitFor("text:chose: menu-solo");
});

test("Shift+F10 on the focused trigger opens the menu at its first item", async () => {
  const app = await open("./fixtures/context-menu.tsx", { platform: "web" });
  await app.keyboard.press("tab");
  await app.keyboard.press("shift+f10");
  await app.waitFor("text:menu-solo");
  // The keyboard focus is on the first item: Space chooses it.
  await app.keyboard.press("space");
  await app.waitFor("text:chose: menu-solo");
  await app.waitFor("text:tapped: none");
});
