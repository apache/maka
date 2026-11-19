// Run with --target android: the dialog is a separate Android window.
import { open, test } from "nsh/test";

test("a dialog keeps hardware keyboard input after Keyboard.dismiss", async () => {
  const app = await open("./App.tsx");
  await app.waitFor("id:note");
  await app.type("id:note", "note");
  await app.waitFor("Focused: yes");
  await app.press("id:blank");
  await app.waitFor("Focused: no");
  // The modal's own container must receive the next key. Focusing decor
  // bypasses that container; focusing the activity crosses the window.
  await app.keyboard.press("Tab");
  await app.waitFor("Focused: yes");
});
