// Tabs from TSX: a list with no `orientation` moves its selection with
// either pair of arrows; a horizontal one moves with Right and leaves Down
// to the page; a vertical one moves with Down and leaves Right to the page.
// A list that took the other pair would move the focus there and select the
// next tab (automatic activation).
import { expect, open, test } from "nsh/test";

const desktop = { width: 600, height: 500, platform: "macos" } as const;

test("a list with no orientation moves with either pair", async () => {
  const app = await open("./fixtures/tabs-orientation.tsx", desktop);
  await app.keyboard.press("tab");
  await app.keyboard.press("right");
  await app.waitFor("text:Default selected: two");
  await app.keyboard.press("down");
  await app.waitFor("text:Default selected: three");
  await app.keyboard.press("up");
  await app.waitFor("text:Default selected: two");
});

test("a horizontal list moves with Right, and Down stays on its tab", async () => {
  const app = await open("./fixtures/tabs-orientation.tsx", desktop);
  // The first list, then the row.
  await app.keyboard.press("tab");
  await app.keyboard.press("tab");
  await app.keyboard.press("right");
  await app.waitFor("text:Row selected: two");
  await app.keyboard.press("down");
  await app.wait(300);
  expect(app.shows("text:Row selected: two")).toBe(true);
  expect(app.shows("text:Row selected: three")).toBe(false);
});

test("a vertical list moves with Down, and Right stays on its tab", async () => {
  const app = await open("./fixtures/tabs-orientation.tsx", desktop);
  // The first list, the row, then the column.
  await app.keyboard.press("tab");
  await app.keyboard.press("tab");
  await app.keyboard.press("tab");
  await app.keyboard.press("down");
  await app.waitFor("text:Column selected: two");
  await app.keyboard.press("right");
  await app.wait(300);
  expect(app.shows("text:Column selected: two")).toBe(true);
  expect(app.shows("text:Column selected: three")).toBe(false);
});
