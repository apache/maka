// A view with a `panActivation` over a scroll view (a chat's composer over
// its messages) takes its vertical drags; the scroll view under it stays.
import { expect, open, test } from "nsh/test";

test("a vertical drag on a pan view over a scroll view pans the view, not the scroll view", async () => {
  const app = await open("./fixtures/pan-over-scroll.tsx");
  await app.drag("id:card", { x: 0, y: -120 });
  await app.waitFor("text:card: dragged");
  expect(app.texts()).toContain("list: at top");
});

test("a vertical drag on a sideways pan view inside a scroll view scrolls it", async () => {
  const app = await open("./fixtures/pan-over-scroll.tsx");
  await app.drag("id:chart", { x: 0, y: -200 });
  await app.waitFor("text:list: scrolled");
});

test("a tap on a pan view inside a pressable view presses it; a pan does not", async () => {
  const app = await open("./fixtures/pan-over-scroll.tsx");
  await app.drag("id:spark", { x: 120, y: 0 });
  await app.waitFor("text:spark: scrubbed");
  expect(app.texts()).toContain("stock: closed");
  await app.press("id:spark");
  await app.waitFor("text:stock: opened");
});
