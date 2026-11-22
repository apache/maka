// Keyboard.dismiss() hides the keyboard after the field that showed it is gone,
// as when a screen that was typed in closes; and when the field is still open
// in a Dialog (Android: a separate window, so host.findFocus() misses it).
import { open, test } from "nsh/test";

test("Keyboard.dismiss() hides the keyboard of a field that is gone", async () => {
  const app = await open("./fixtures/keyboard-dismiss.tsx");
  await app.type("id:name", "test1");
  await app.press("Next");
  await app.waitFor("Next screen");
  await app.waitFor("text:keyboard: down");
});

test("Keyboard.dismiss() blurs an input in a Dialog", async () => {
  const app = await open("./fixtures/keyboard-dismiss-dialog.tsx");
  await app.waitFor("id:note");
  await app.type("id:note", "少辣");
  await app.waitFor("Focused: yes");
  await app.press("id:blank");
  await app.waitFor("Focused: no");
});
