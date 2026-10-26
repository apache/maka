// The Rust native-batch replay asserts the entrance's first translation;
// UIKit checks the real lazy JS path, lifecycle, reflow and kept drawers.
import { expect, open, test } from "nsh/test";

test("lazy sheets and a phone menu enter on every opening", async () => {
  const app = await open("./Entrance.tsx");
  let count = 0;
  for (const name of ["Default", "Swipe", "Menu"]) {
    for (let opening = 0; opening < 2; opening++) {
      await app.press(`id:open-${name}`);
      await app.waitFor(`opened:${count + 1} closed:${count}`);
      expect(app.shows("Extent 300")).toBe(true);
      await app.press("id:entrance-close");
      count++;
      await app.waitFor(`opened:${count} closed:${count}`);
      expect(app.shows("Lazy body")).toBe(false);
    }
  }
  await app.press("id:underlying");
  expect(app.shows("taps:1")).toBe(true);
});

test("content can grow asynchronously while a sheet enters", async () => {
  const app = await open("./Entrance.tsx");
  await app.press("id:open-Async");
  await app.waitFor("Extent 500");
  await app.waitFor("opened:1 closed:0");
  await app.drag("id:entrance-close", { x: 0, y: 200 });
  await app.waitFor("opened:1 closed:1");
  await app.press("id:underlying");
  expect(app.shows("taps:1")).toBe(true);
});

test("reduced motion settles lazy and growing content at rest", async () => {
  const app = await open("./Entrance.tsx", { reducedMotion: true });
  await app.press("id:open-Async");
  await app.waitFor("Extent 500");
  await app.waitFor("opened:1 closed:0");
  await app.press("id:entrance-close");
  await app.waitFor("opened:1 closed:1");
});

test("a kept compact dock drawer opens and closes repeatedly", async () => {
  const app = await open("./Entrance.tsx");
  for (let opening = 0; opening < 2; opening++) {
    await app.press("id:open-dock");
    await app.waitFor("Dock body");
    await app.wait(350);
    await app.press("id:dock-close");
    await app.wait(250);
    expect(app.shows("Dock body")).toBe(false);
  }
  await app.press("id:underlying");
  expect(app.shows("taps:1")).toBe(true);
});
