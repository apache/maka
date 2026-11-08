// Windows of the app's own (`nsh/desktop`'s `Window`, `currentWindow()`,
// `windows()`): what the app does with them, which every run checks
// (headless, the app runs as macOS; on a real platform, in its windows).
// What the platform reports of them is window-state.test.tsx's.
import { expect, open, test } from "nsh/test";

const FIXTURE = "./fixtures/windows.tsx";
const OPTIONS = { platform: "macos", width: 900, height: 700 } as const;

test("Window.open opens one window per id, and close() closes it", async () => {
  const app = await open(FIXTURE, OPTIONS);
  await app.waitFor("Windows: main");
  await app.waitFor("Get: main=main notes=none");
  await app.press("Open notes");
  // A second `Window.open` of the id returns the window already open.
  await app.waitFor("Opened: same ref");
  await app.waitFor("Windows: main,notes");
  await app.waitFor("Get: main=main notes=notes");
  await app.press("Close notes");
  await app.waitFor("Windows: main");
  await app.waitFor("Get: main=main notes=none");
  // Its `close` listener heard it once.
  await app.waitFor("Close events: 1");
  await app.press("Open notes");
  await app.waitFor("Windows: main,notes");
  await app.press("Close notes");
  await app.waitFor("Close events: 2");
});

test("currentWindow() is the window a component renders in, the main one outside any", async () => {
  const app = await open(FIXTURE, OPTIONS);
  await app.waitFor("Main: main true");
  await app.press("Open notes");
  await app.waitFor("Notes inside: notes");
  await app.press("Open panel");
  await app.waitFor("Panel inside: panel");
});

test("currentWindow() throws outside a component", async () => {
  const app = await open(FIXTURE, OPTIONS);
  await app.waitFor("Outside: not called");
  await app.press("Call outside");
  await app.waitFor("Outside: TypeError");
});

test("<Window> opens while open is true and closes when it turns false, without onOpenChange", async () => {
  const app = await open(FIXTURE, OPTIONS);
  await app.press("Open panel");
  await app.waitFor("Windows: main,panel");
  await app.press("Open notes");
  // In the order they opened.
  await app.waitFor("Windows: main,panel,notes");
  await app.press("Close panel");
  await app.waitFor("Windows: main,notes");
  // The app closed it: nothing to tell the app.
  expect(app.shows("Panel log: none")).toBe(true);
});

test("WindowRef.close() of a <Window> tells the app through onOpenChange", async () => {
  const app = await open(FIXTURE, OPTIONS);
  await app.press("Open guard");
  await app.waitFor("Windows: main,guard");
  await app.press("Close guard");
  await app.waitFor("Windows: main");
  await app.waitFor("Guard log: closed close");
});

test("an overlay the app did not declare is refused", async () => {
  const app = await open(FIXTURE, OPTIONS);
  await app.press("Open overlay");
  await app.waitFor("Overlay: ERR_ACCESS_DENIED windows");
  expect(app.shows("Windows: main")).toBe(true);
});

test("the Windows demo's inspector is a window that shares the page's state", async () => {
  const app = await open("../App.tsx", { platform: "macos", width: 1200, height: 800 });
  await app.press("label:Windows");
  await app.waitFor("id:window-main");
  await app.press("label:Inspector");
  await app.waitFor("id:window-inspector");
  // The inspector's own content, rendered by the page's engine.
  await app.waitFor("Text size");
  // The toolbar's button is the window's `open`: off, the window closes.
  await app.press("label:Inspector");
  await app.waitFor("id:window-inspector", { state: "gone" });
});
