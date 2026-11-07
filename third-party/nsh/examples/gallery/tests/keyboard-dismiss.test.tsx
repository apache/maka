// Keyboard.dismiss() hides the keyboard after the field that showed it is gone,
// as when a screen that was typed in closes.
import { open, test } from "nsh/test";

test("Keyboard.dismiss() hides the keyboard of a field that is gone", async () => {
  const app = await open("./fixtures/keyboard-dismiss.tsx");
  await app.type("id:name", "test1");
  await app.press("Next");
  await app.waitFor("Next screen");
  await app.waitFor("text:keyboard: down");
});
