// What the platform reports of a window of the app's own (`state()`), the
// requests that change it and the defaults of the window kinds, in real
// windows (`nsh test --target macos|windows|linux|gpui`; CI runs Linux and
// Windows). Headless, the driver plays the platform's windows.
import { expect, open, test } from "nsh/test";

const FIXTURE = "./fixtures/windows.tsx";
const OPTIONS = { platform: "macos", width: 900, height: 700 } as const;

test("state() reports a window, and its requests change it", async () => {
  const app = await open(FIXTURE, OPTIONS);
  await app.press("Open notes");
  // Shown once its first frame is mounted, with the keyboard focus.
  await app.waitFor("text:/^Notes: mode=normal minimized=false visible=true focused=true /");
  await app.waitFor("Focused: notes");
  await app.press("Resize notes");
  await app.waitFor("text:/^Notes: .* size=360x240 /");
  await app.press("Maximize notes");
  await app.waitFor("text:/^Notes: mode=maximized /");
  // An intent, not a toggle: normal again.
  await app.press("Normal notes");
  await app.waitFor("text:/^Notes: mode=normal /");
  await app.press("Minimize notes");
  await app.waitFor("text:/^Notes: mode=normal minimized=true visible=false /");
  await app.press("Restore notes");
  await app.waitFor("text:/^Notes: mode=normal minimized=false visible=true /");
});

test("set() changes what the platform reports: sizeToContent fits the window to its content", async () => {
  const app = await open(FIXTURE, OPTIONS);
  await app.press("Open notes");
  await app.waitFor("text:/^Notes: mode=normal /");
  await app.press("Fit notes");
  await app.waitFor("text:/^Notes: .* content=240x120$/");
});

test("a panel opens without taking the focus; a popup closes when the focus leaves it", async () => {
  const app = await open(FIXTURE, OPTIONS);
  await app.press("Open notes");
  await app.waitFor("Focused: notes");
  // A panel does not activate: the main window, whose button opened it,
  // keeps the focus.
  await app.press("Open panel");
  await app.waitFor("text:/^Panel: mode=normal minimized=false visible=true focused=false /");
  await app.waitFor("Focused: main");
  await app.press("Open popup");
  await app.waitFor("text:/^Popup: .* focused=true /");
  await app.press("Focus main");
  await app.waitFor("Popup log: blur");
  await app.waitFor("Windows: main,notes,panel");
});

test("a dialog closes on Escape", async () => {
  const app = await open(FIXTURE, OPTIONS);
  await app.press("Open dialog");
  await app.waitFor("text:/^Dialog: .* focused=true /");
  await app.keyboard.press("escape");
  await app.waitFor("Dialog log: escape");
  await app.waitFor("Windows: main");
});

test("closeOnPress: false keeps the window open and reports closePress", async () => {
  const app = await open(FIXTURE, OPTIONS);
  await app.press("Open guard");
  await app.waitFor("Windows: main,guard");
  // The user's press on its close button: reported, and the window stays.
  await app.window("guard").pressClose();
  await app.waitFor("Guard log: closePress closeButton");
  expect(app.window("guard").state()?.visible).toBe(true);
  expect(app.shows("Windows: main,guard")).toBe(true);
  // The app's own `close()`, which the policy lets through.
  await app.press("Close guard");
  await app.waitFor("Windows: main");
  await app.waitFor("Guard log: closed close");
});

test("the close button closes a window that does not keep itself open", async () => {
  const app = await open(FIXTURE, OPTIONS);
  await app.press("Open notes");
  await app.waitFor("Windows: main,notes");
  await app.window("notes").pressClose();
  await app.waitFor("Windows: main");
  await app.waitFor("Close events: 1");
  expect(app.window("notes").state()).toBe(null);
});
