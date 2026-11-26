// A stop under a transparent view (#3027). A ref's `focus()` reaches it,
// as on the other platforms, where opacity keeps no focus away: a menu whose
// popup comes in from `opacity: 0` (its starting look) has its first item
// focused as the keyboard opens it, and Return chooses that item. Tab and
// UIKit's focus engine still pass over a transparent stop, as it is not
// shown. The menu is a popup on an iPad in a regular width; a sheet, which
// comes in by its own motion, elsewhere.
import { open, test } from "nsh/test";

test("a ref's focus() reaches a stop under a transparent view", async () => {
  const app = await open("./TransparentFocus.tsx");
  await app.press("id:focusVeiled");
  await app.waitFor("text:focus:veiled");
});

test("tab passes over a stop under a transparent view", async () => {
  const app = await open("./TransparentFocus.tsx");
  await app.keyboard.press("tab");
  await app.wait(200);
  await app.keyboard.press("tab");
  await app.waitFor("text:focus:after");
});

test("a menu coming in from opacity 0 has its first item focused as the keyboard opens it", async () => {
  const app = await open("./TransparentFocus.tsx");
  await app.keyboard.press("tab");
  await app.wait(200);
  await app.keyboard.press("space");
  await app.waitFor("one");
  await app.wait(300);
  await app.keyboard.press("enter");
  await app.waitFor("text:chose:one");
});
