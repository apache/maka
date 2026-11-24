import { expect, open, test } from "nsh/test";

test("Android's bottom sheet avoids the keyboard once", async () => {
  const app = await open("./fixtures/sheet-keyboard.tsx");
  // Android presents the sheet in a native window already sized above
  // the IME. A headless or another platform's root is not that window.
  if (!app.shows("Platform: android")) return;
  await app.waitFor("id:sheet-close");
  await app.type("id:note", "A note");
  // A missing software keyboard must fail this native regression.
  await app.waitFor("text:keyboard: up");
  expect(app.shows("id:sheet-title")).toBe(true);
  expect(app.shows("id:sheet-close")).toBe(true);
  expect(app.shows("id:sheet-footer")).toBe(true);
  // Safe-area padding overlaps the keyboard, as without a native modal:
  // the footer itself ends at the IME instead of leaving a second gap.
  await app.host.send("test:measure-footer");
  await app.waitFor("text:footer: aligned");
  await app.press("id:sheet-footer");
  await app.waitFor("text:footer: pressed");
  await app.type("id:note", "A final note");
  await app.waitFor("text:keyboard: up");
  await app.press("id:sheet-close");
  await app.waitFor("text:sheet: closed");
});
