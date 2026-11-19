// The gallery's Quit asks first: its own item in the application menu,
// with the quit key, shows a dialog; only its Quit button quits.
import { expect, open, test } from "nsh/test";

test("the quit key asks before quitting", async () => {
  const app = await open("../App.tsx", { platform: "macos", width: 1200, height: 800 });
  await app.waitFor("role:button[System]");
  await app.keyboard.press("mod+q");
  const [dialog] = app.dialogs();
  expect(dialog.title).toBe("Quit NSH Gallery?");
  expect(dialog.buttons).toEqual(["Cancel", "Quit"]);
  // Unanswered, its Cancel keeps the gallery open.
  await app.waitFor("role:button[System]");
});

test("phones have no application menu to quit from", async () => {
  const app = await open("../App.tsx", { platform: "ios" });
  await app.waitFor("Primitives");
  await app.keyboard.press("mod+q");
  expect(app.dialogs()).toEqual([]);
});
