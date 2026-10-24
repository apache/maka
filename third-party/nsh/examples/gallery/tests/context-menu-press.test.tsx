// A context menu's trigger is pressed like any view: a tap presses it and
// opens no menu, on every platform.
import { expect, open, test } from "nsh/test";

test("a tap presses the trigger of a context menu", async () => {
  const app = await open("./fixtures/context-menu.tsx");
  await app.press("text:solo");
  await app.waitFor("tapped: solo");
  await app.wait(800);
  expect(app.menu()).toBe(null);
});

test("a held finger opens the menu over the trigger's press", async () => {
  const app = await open("./fixtures/context-menu.tsx");
  await app.longPress("text:solo");
  await app.press("text:menu-solo");
  await app.waitFor("chose: menu-solo");
});
