// UIKit regression: run this directory with `nsh test --target ios`. A page
// scrolled down its content keeps its place while a menu in its header
// opens and closes: the system's tap at the top of the screen, which
// scrolls to the top, leaves a press to the view pressed.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

/** The page's scroll offset once it settled. */
async function offset(app: App): Promise<number> {
  await app.wait(700);
  const line = app.texts().find((t) => t.startsWith("offset:")) ?? "";
  return Number(line.slice("offset:".length));
}

/** Scrolls the page well down its rows; where it rests. */
async function scrolled(app: App): Promise<number> {
  await app.scroll("id:rows", 600);
  const before = await offset(app);
  expect(before).toBeGreaterThan(300);
  return before;
}

async function keepsPlace(menu: string, item: string) {
  const app = await open("./MenuScroll.tsx");
  const before = await scrolled(app);
  await app.press(`id:${menu}`);
  await app.waitFor(`text:${item}`);
  expect(await offset(app)).toBe(before);
  await app.press(`text:${item}`);
  await app.waitFor(`text:${item}`, { state: "gone" });
  expect(await offset(app)).toBe(before);
}

test("a menu in the header keeps the page's scroll view where it was", async () => {
  await keepsPlace("header-menu", "Keep Header");
});

test("a menu in the content keeps the page's scroll view where it was", async () => {
  await keepsPlace("content-menu", "Keep Content");
});

test("a tap on a view in the header with nothing to press still scrolls to the top", async () => {
  const app = await open("./MenuScroll.tsx");
  await scrolled(app);
  // A finger down and up on it, as a tap: nothing there takes presses.
  await app.drag("id:header-label", { x: 0, y: 0 });
  expect(await offset(app)).toBe(0);
});
