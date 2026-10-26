// UIKit gesture regression: run this directory with `nsh test --target ios`.
// A drag starts at the window's left edge and reaches UIKit through IOHID;
// `app.back()` would press the header and miss the hidden-header regression.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

async function swipe(app: App) {
  await app.drag("id:edge", { x: 300, y: 0 });
  await app.wait(800);
}

for (const name of ["Visible header", "Hidden header"]) {
  test(`an edge swipe pops a page with ${name.toLowerCase()}`, async () => {
    const app = await open("./App.tsx");
    await app.press(`text:${name}`);
    await app.waitFor("text:depth:2");
    await app.wait(800);
    await swipe(app);
    await app.waitFor("text:depth:1");
    expect(app.shows("dismissed:1")).toBe(true);
  });
}

for (const name of ["Swipe disabled", "Back disabled", "Visible swipe disabled", "Visible back disabled"]) {
  test(`an edge swipe respects ${name.toLowerCase()}`, async () => {
    const app = await open("./App.tsx");
    await app.press(`text:${name}`);
    await app.waitFor("text:depth:2");
    await app.wait(800);
    await swipe(app);
    expect(app.shows("depth:2")).toBe(true);
    expect(app.shows("dismissed:0")).toBe(true);
    // iOS 26 can also initiate the same transition from the content area.
    await app.drag("id:content", { x: 280, y: 0 });
    await app.wait(800);
    expect(app.shows("depth:2")).toBe(true);
    expect(app.shows("dismissed:0")).toBe(true);
    await app.press("text:Custom back");
    await app.waitFor("text:depth:1");
  });
}

test("an edge swipe leaves the root page in place", async () => {
  const app = await open("./App.tsx");
  await swipe(app);
  await app.drag("id:content", { x: 280, y: 0 });
  await app.wait(800);
  expect(app.shows("depth:1")).toBe(true);
  expect(app.shows("dismissed:0")).toBe(true);
});

test("hidden-header swipes keep working after returning to the root", async () => {
  const app = await open("./App.tsx");
  for (let n = 1; n <= 2; n++) {
    await app.press("text:Hidden header");
    await app.waitFor("text:depth:2");
    await app.wait(800);
    await swipe(app);
    await app.waitFor("text:depth:1");
    expect(app.shows(`dismissed:${n}`)).toBe(true);
  }
});

test("vertical and reverse drags keep a hidden-header page in place", async () => {
  const app = await open("./App.tsx");
  await app.press("text:Hidden header");
  await app.waitFor("text:depth:2");
  await app.wait(800);
  for (const by of [{ x: 0, y: 250 }, { x: -80, y: 0 }]) {
    await app.drag("id:content", by);
    await app.wait(800);
    expect(app.shows("depth:2")).toBe(true);
    expect(app.shows("dismissed:0")).toBe(true);
  }
  await swipe(app);
  await app.waitFor("text:depth:1");
  expect(app.shows("dismissed:1")).toBe(true);
});
