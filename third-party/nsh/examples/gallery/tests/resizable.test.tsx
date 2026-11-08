// The Resizable demo: `nsh/base`'s `ResizablePanelGroup` in a desktop
// window (1200 × 800), a sidebar beside an editor over a console. A
// handle's drag resizes the panels within their ranges and reports the
// sizes when it ends, which the demo shows and passes back; a hidden
// panel comes back at its size.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

/** How the demo shows each panel's size: the sidebar's width, the console's height. */
const unit: Record<string, string> = { Sidebar: " pt wide", Console: " pt tall" };

/** The size the demo shows for `panel` (`"Sidebar"`, `"Console"`). */
const size = (app: App, panel: string) => {
  const line = app.texts().find((t) => /^\d/.test(t) && t.endsWith(unit[panel]));
  return line === undefined ? NaN : parseFloat(line);
};

/** Waits for a size within 2 points of `want` (real platforms' pointers may round). */
const waitForSize = (app: App, panel: string, want: number) => app.waitUntil(() => Math.abs(size(app, panel) - want) <= 2);

let app: App;
beforeEach(async () => {
  app = await open("../App.tsx", { platform: "macos", width: 1200, height: 800, clock: {} });
  await app.press("role:button[Resizable]");
  await app.waitFor("220 pt wide");
});

test("dragging a handle resizes the panels beside it, and the group reports the sizes", async () => {
  expect(app.count("role:adjustable")).toBe(2);
  await app.drag("label:Resize the sidebar", { x: 60, y: 0 });
  await waitForSize(app, "Sidebar", 280);
  expect(app.texts().some((t) => t.startsWith("Last resize: Row: "))).toBe(true);
  await app.drag("label:Resize the console", { x: 0, y: -40 });
  await waitForSize(app, "Console", 180);
  expect(app.texts().some((t) => t.startsWith("Last resize: Column: "))).toBe(true);
});

test("a panel stops at its minimum and its maximum", async () => {
  await app.drag("label:Resize the sidebar", { x: -300, y: 0 });
  await waitForSize(app, "Sidebar", 120);
  await app.drag("label:Resize the sidebar", { x: 400, y: 0 });
  await waitForSize(app, "Sidebar", 360);
});

test("a hidden panel gives its room back and returns at its size", async () => {
  await app.drag("label:Resize the console", { x: 0, y: -40 });
  await waitForSize(app, "Console", 180);
  await app.press("label:Hide the console");
  await app.waitFor("label:Resize the console", { state: "gone" });
  expect(app.shows("Hidden, it keeps its size")).toBe(false);
  await app.press("label:Show the console");
  await app.waitFor("label:Resize the console");
  await waitForSize(app, "Console", 180);
});
