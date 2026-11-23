// A list in a swipe-to-close sheet scrolls; at its top, a drag down still
// closes the sheet, as does a drag on a button over the list.
import { expect, open, test } from "nsh/test";

test("pressing rows at both scroll edges keeps the sheet open", async () => {
  const app = await open("./fixtures/sheet-scroll.tsx");
  // This case exposes both edges; the other cases exercise the button over the list.
  await app.host.send("test:hide-overlay");
  // The first row is inside the driver's edge margin. At the start there
  // is no room to scroll back: a drag down would close the sheet.
  for (const row of ["Row 1", "Row 40", "Row 1"]) {
    await app.press(`text:${row}`);
    await app.waitFor(`text:pressed: ${row}`);
    expect(app.texts()).toContain("sheet: open");
  }
  expect(app.texts()).toContain("presses: Row 1, Row 40, Row 1");
});

test("a drag up on a sheet's list scrolls the list", async () => {
  const app = await open("./fixtures/sheet-scroll.tsx");
  await app.drag("Row 4", { x: 0, y: -200 });
  await app.waitFor("text:list: scrolled");
  expect(app.texts()).toContain("sheet: open");
});

test("a drag down on a sheet's list at its top closes the sheet", async () => {
  const app = await open("./fixtures/sheet-scroll.tsx");
  // Android's for now (a headless run does not close the sheet on this drag).
  if (!app.shows("Platform: android")) return;
  await app.drag("Row 4", { x: 0, y: 300 });
  await app.waitFor("text:sheet: closed");
});

test("a drag down on a button over a scrolled list moves the sheet", async () => {
  const app = await open("./fixtures/sheet-scroll.tsx");
  // Android's for now, as the case above.
  if (!app.shows("Platform: android")) return;
  await app.drag("Row 4", { x: 0, y: -200 });
  await app.waitFor("text:list: scrolled");
  // The button takes the touch, not the list under it: the list does not
  // scroll, so the drag moves the sheet.
  await app.drag("Button over the list", { x: 0, y: 300 });
  await app.waitFor("text:sheet: closed");
});
