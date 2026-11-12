import { expect, open, test } from "nsh/test";

const DESKTOP = { platform: "macos" } as const;

test("a menu item's shortcut chooses it", async () => {
  const app = await open("./App.tsx", DESKTOP);
  await app.keyboard.press("mod+n");
  await app.waitFor("Chosen: New");
});

test("a disabled item's shortcut chooses nothing", async () => {
  const app = await open("./App.tsx", DESKTOP);
  await app.keyboard.press("mod+s");
  await app.wait(100);
  expect(app.texts()).toContain("Chosen: nothing");
});

test("an item that leaves its shortcut to a focused field is not chosen while one edits", async () => {
  const app = await open("./App.tsx", DESKTOP);
  await app.type("id:field", "a");
  await app.keyboard.press("mod+e");
  await app.wait(100);
  expect(app.texts()).toContain("Chosen: nothing");
  await app.keyboard.press("mod+n");
  await app.waitFor("Chosen: New");
});
