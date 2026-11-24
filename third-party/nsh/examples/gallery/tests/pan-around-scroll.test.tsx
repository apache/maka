// A sideways pan view around a vertical scroll view (a schedule's timeline
// around its rows) takes the drags that are mostly sideways when the
// finger passes the offsets, however steep; the rows scroll with the rest.
import { expect, open, test } from "nsh/test";

test("a mostly sideways diagonal on a sideways pan view around a scroll view pans the view", async () => {
  const app = await open("./fixtures/pan-around-scroll.tsx");
  await app.drag("id:row-3", { x: -150, y: -100 });
  await app.waitFor("text:timeline: panned");
  expect(app.texts()).toContain("list: at top");
});

test("a mostly vertical diagonal on a sideways pan view around a scroll view scrolls it", async () => {
  const app = await open("./fixtures/pan-around-scroll.tsx");
  await app.drag("id:row-3", { x: -100, y: -150 });
  await app.waitFor("text:list: scrolled");
  expect(app.texts()).toContain("timeline: still");
});

test("a tap that wobbles sideways under the offset presses a row inside", async () => {
  const app = await open("./fixtures/pan-around-scroll.tsx");
  await app.drag("id:row-3", { x: 8, y: 0 });
  await app.waitFor("text:pressed: row 3");
  expect(app.texts()).toContain("timeline: still");
});
