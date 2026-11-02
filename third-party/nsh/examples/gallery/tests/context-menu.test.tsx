// A context menu on a right click (`Menu.popup`), on a desktop (headless,
// the app runs as macOS; on a real platform, as it).
import { expect, open, test } from "nsh/test";

test("a right click shows the menu, and its items are chosen", async () => {
  const app = await open("../App.tsx", { platform: "macos" });
  await app.press("label:System");
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
