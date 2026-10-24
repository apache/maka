// UIKit input through IOHID, including the descendant UIScrollView's pan.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

async function show(app: App, name: string) {
  await app.press(`text:${name}`);
  await app.waitFor("Sheet body");
  await app.wait(450);
}

test("a short panel dismisses from its styled handle", async () => {
  const app = await open("./App.tsx");
  await show(app, "Short");
  await app.drag("id:handle", { x: 0, y: 130 });
  await app.waitFor("closed:1 reason:swipe cancel:1");
  expect(app.shows("Sheet body")).toBe(false);
  await app.press("Underlying button");
  expect(app.shows("taps:1")).toBe(true);
});

test("a short drag settles back and remains usable", async () => {
  const app = await open("./App.tsx");
  await show(app, "Short");
  await app.drag("id:handle", { x: 0, y: 20 });
  await app.wait(450);
  expect(app.shows("closed:0 reason:none cancel:0")).toBe(true);
  await app.press("Close");
  await app.waitFor("closed:1 reason:none cancel:0");
});

test("reduced motion keeps direct dragging and closes without residual overlays", async () => {
  const app = await open("./App.tsx", { reducedMotion: true });
  await show(app, "Short");
  await app.drag("id:handle", { x: 0, y: 130 });
  await app.waitFor("closed:1 reason:swipe cancel:1");
  await app.press("Underlying button");
  expect(app.shows("taps:1")).toBe(true);
});

test("the default and a changed permission preserve the panel", async () => {
  const app = await open("./App.tsx");
  await show(app, "Default");
  await app.drag("id:handle", { x: 0, y: 130 });
  await app.wait(350);
  expect(app.shows("closed:0 reason:none cancel:0")).toBe(true);
  await app.press("Unlock");
  await app.drag("id:handle", { x: 0, y: 130 });
  await app.waitFor("closed:1 reason:swipe cancel:1");
});

test("a controlled owner may decline a swipe close", async () => {
  const app = await open("./App.tsx");
  await show(app, "Decline");
  await app.drag("id:handle", { x: 0, y: 130 });
  await app.wait(450);
  expect(app.shows("closed:0 reason:swipe cancel:1")).toBe(true);
  await app.press("Close");
  await app.waitFor("closed:1 reason:swipe cancel:1");
});

test("scrolling reaches the top and hands the same drag to the panel", async () => {
  const app = await open("./App.tsx");
  await show(app, "Scroll");
  await app.scroll("id:scroll", 100);
  await app.wait(250);
  await app.drag("id:row-3", { x: 0, y: 260 });
  await app.waitFor("closed:1 reason:swipe cancel:1");
});

test("a drag still within the scroll content keeps the panel open", async () => {
  const app = await open("./App.tsx");
  await show(app, "Scroll");
  await app.scroll("id:scroll", 350);
  await app.wait(250);
  await app.drag("id:row-10", { x: 0, y: 100 });
  await app.wait(450);
  expect(app.shows("closed:0 reason:none cancel:0")).toBe(true);
  await app.drag("id:handle", { x: 0, y: 180 });
  await app.waitFor("closed:1 reason:swipe cancel:1");
});

test("a scroll with short content also hands down dragging to the panel", async () => {
  const app = await open("./App.tsx");
  await show(app, "Short scroll");
  await app.drag("id:scroll", { x: 0, y: 180 });
  await app.waitFor("closed:1 reason:swipe cancel:1");
});

test("reopening during exit leaves a usable sheet and removes its backdrop after closing", async () => {
  const app = await open("./App.tsx");
  await show(app, "Short");
  await app.press("Reopen");
  await app.wait(600);
  expect(app.shows("Sheet body")).toBe(true);
  await app.press("Close");
  await app.wait(450);
  expect(app.shows("Sheet body")).toBe(false);
  await app.press("Underlying button");
  expect(app.shows("taps:1")).toBe(true);
});

test("an older exit cannot finish a newer interrupted exit", async () => {
  const app = await open("./App.tsx");
  await show(app, "Short");
  await app.press("Cycle");
  await app.wait(650);
  expect(app.shows("closed:0 reason:none cancel:0")).toBe(true);
  await app.press("Close");
  await app.waitFor("closed:1 reason:none cancel:0");
  await app.press("Underlying button");
  expect(app.shows("taps:1")).toBe(true);
});
