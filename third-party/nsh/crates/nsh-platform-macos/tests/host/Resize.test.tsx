// A window `setViewport` resizes on the macOS host (`nsh test
// crates/nsh-platform-macos/tests/host --target macos`) gets that content
// size and stays on its display: grown from where it opened, centered and
// narrow, it would reach past the display's edge, where a screenshot shows
// nothing. For the macOS host only, like `App.test.tsx`.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

const near = (a: number, b: number) => Math.abs(a - b) < 1;

async function resized(app: App, width: number, height: number) {
  const main = app.window("main");
  await app.setViewport(width, height);
  await app.waitUntil(() => near(main.state()!.contentBounds.size.width, width));
  return main.state()!;
}

test("a window grown by setViewport stays on its display", async () => {
  const app = await open("./Resize.tsx");
  await app.waitFor("text:/^\\[/");
  const opened = app.window("main").state()!;
  expect(opened.display).toBeDefined();
  const displays = JSON.parse(app.texts().find((t) => t.startsWith("["))!);
  const area = displays.find((d: { id: string }) => d.id === opened.display).visibleBounds;
  const state = await resized(app, area.size.width - 20, opened.contentBounds.size.height);
  const { origin, size } = state.bounds;
  expect(origin.x).toBeGreaterThanOrEqual(area.origin.x);
  expect(origin.x + size.width).toBeLessThanOrEqual(area.origin.x + area.size.width);
  expect(origin.y).toBeGreaterThanOrEqual(area.origin.y);
  expect(origin.y + size.height).toBeLessThanOrEqual(area.origin.y + area.size.height);
  expect(state.display).toBe(opened.display);
});

test("setViewport gives a window with a hidden title bar that content size", async () => {
  const app = await open("./TitleBar.tsx");
  await app.waitFor("Presses: 0");
  const state = await resized(app, 600, 500);
  expect(near(state.contentBounds.size.height, 500)).toBe(true);
});
