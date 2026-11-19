// UIKit regression: run this directory with `nsh test --target ios`. The
// views a page puts in its header's slots sit in the navigation bar, whose
// top-edge tap recognizer (iOS 26+) must not prevent their presses.
import { open, test } from "nsh/test";

test("a button in the header's trailing slot is pressed", async () => {
  const app = await open("./Items.tsx");
  await app.press("id:header-button");
  await app.waitFor("text:Header button: 1");
});

test("a pressable view in the header's trailing slot is pressed", async () => {
  const app = await open("./Items.tsx");
  await app.press("id:header-view");
  await app.waitFor("text:Header view: 1");
});

test("a menu in the header's trailing slot opens and its item pushes a page", async () => {
  const app = await open("./Items.tsx");
  await app.press("id:header-menu");
  await app.press("text:Open page");
  await app.waitFor("text:Page: pushed");
});
