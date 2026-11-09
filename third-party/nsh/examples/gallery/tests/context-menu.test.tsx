// A context menu on a right click (`Menu.popup`), on a desktop (headless,
// the app runs as macOS; on a real platform, as it). The gallery opens on
// the System demo, as it reopens the demo left open last time: the test
// checks the menu, not the way to the demo, which on a phone-sized window
// takes many scroll gestures (slow in GPUI windows under Xvfb, #1210).
import { expect, open, test } from "nsh/test";

test("a right click shows the menu, and its items are chosen", async () => {
  const app = await open("../App.tsx", { platform: "macos", storage: { lastDemo: "System" } });
  await app.rightClick("id:menu-target");
  expect(app.menu()).toEqual([
    { label: "Copy", disabled: false },
    { label: "Paste", disabled: true },
    { label: "Share > Mail", disabled: false },
  ]);
  await expect(() => app.chooseMenuItem("Paste")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  await app.chooseMenuItem("Share > Mail");
  await app.waitFor("Chose Share > Mail");
  expect(app.menu()).toBe(null);
  await app.rightClick("id:menu-target");
  await app.closeMenu();
  expect(app.menu()).toBe(null);
  await app.rightClick("id:menu-target");
  await app.chooseMenuItem("Copy");
  await app.waitFor("Chose Copy");
});
