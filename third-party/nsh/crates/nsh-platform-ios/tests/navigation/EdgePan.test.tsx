// Screen edge pans with drags of the test agent: run this directory with
// `nsh test --target ios`. A drag that starts at the screen's edge comes in
// over it, as a finger swiping from the edge does.
import { expect, open, test } from "nsh/test";

test("a drag from the screen's left edge starts a left edge pan", async () => {
  const app = await open("./EdgePan.tsx");
  await app.waitFor("text:depth:1 left:0 right:0");
  await app.drag("id:left-edge", { x: 200, y: 0 });
  await app.waitFor("text:depth:1 left:1 right:0");
});

test("a drag from the screen's right edge starts a right edge pan", async () => {
  const app = await open("./EdgePan.tsx");
  await app.waitFor("text:depth:1 left:0 right:0");
  await app.drag("id:right-edge", { x: -200, y: 0 });
  await app.waitFor("text:depth:1 left:0 right:1");
});

test("a drag inside the screen starts no edge pan", async () => {
  const app = await open("./EdgePan.tsx");
  await app.waitFor("text:depth:1 left:0 right:0");
  await app.drag("id:content", { x: 200, y: 0 });
  await app.wait(800);
  expect(app.shows("text:depth:1 left:0 right:0")).toBe(true);
});

test("a drag from the left edge of a pushed page goes back before the edge pan", async () => {
  const app = await open("./EdgePan.tsx");
  await app.press("text:Push");
  await app.waitFor("text:depth:2 left:0 right:0");
  await app.wait(800);
  await app.drag("id:left-edge", { x: 280, y: 0 });
  await app.waitFor("text:depth:1 left:0 right:0");
  // Back on the root page, the same drag opens the edge pan again.
  await app.wait(800);
  await app.drag("id:left-edge", { x: 200, y: 0 });
  await app.waitFor("text:depth:1 left:1 right:0");
});
