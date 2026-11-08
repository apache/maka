import { expect, open, test } from "nsh/test";

const DESKTOP = { platform: "macos", width: 800, height: 600 } as const;

test("the main window is focused, on one display", async () => {
  const app = await open("./App.tsx", DESKTOP);
  await app.waitFor("Focused: main");
  const main = app.window("main");
  expect(main.id).toBe("main");
  expect(main.state()).toMatchObject({
    mode: "normal",
    minimized: false,
    visible: true,
    focused: true,
    contentBounds: { origin: { x: 0, y: 0 }, size: { width: 800, height: 600 } },
  });
  expect(app.window("notes").state()).toBe(null);
});

test("a window opens shown and focused, and a press goes to the window its view is in", async () => {
  const app = await open("./App.tsx", DESKTOP);
  await app.press("Open notes");
  await app.waitFor("Focused: notes");
  expect(app.window("notes").state()).toMatchObject({
    visible: true,
    focused: true,
    bounds: { origin: { x: 40, y: 60 }, size: { width: 300, height: 200 } },
  });
  expect(app.window("main").state()?.focused).toBe(false);
  // Its button sits where the main window's does, in a window of its own.
  await app.press("In notes");
  await app.waitFor("Presses: notes in notes");
  await app.press("Main button");
  await app.waitFor("Presses: main");
  // The press activated the main window.
  await app.waitFor("Focused: main");
  expect(app.window("notes").state()?.focused).toBe(false);
});

test("a popup closes when the focus leaves it", async () => {
  const app = await open("./App.tsx", DESKTOP);
  await app.press("Open popup");
  await app.waitFor("Focused: popup");
  await app.press("Main button");
  await app.waitFor("Log: popup blur");
  // Hidden at once, closed once the app removes it.
  await app.waitFor("In popup", { state: "gone" });
  await app.waitUntil(() => app.window("popup").state() === null);
});

test("Escape closes the focused dialog", async () => {
  const app = await open("./App.tsx", DESKTOP);
  await app.press("Open dialog");
  await app.waitFor("Focused: dialog");
  await app.keyboard.press("escape");
  await app.waitFor("Log: dialog escape");
  await app.waitFor("Focused: main");
});

test("the close button closes a window, unless it keeps itself open", async () => {
  const app = await open("./App.tsx", DESKTOP);
  await app.press("Open notes");
  await app.waitFor("In notes");
  await app.window("notes").pressClose();
  await app.waitFor("Log: notes closePress");
  await app.waitFor("In notes", { state: "gone" });

  await app.press("Open guard");
  await app.waitFor("In guard");
  await app.window("guard").pressClose();
  await app.waitFor("Log: guard closePress closeButton");
  expect(app.window("guard").state()?.visible).toBe(true);
  expect(app.shows("In guard")).toBe(true);
  await app.press("Close guard");
  await app.waitFor("Log: guard close");
  await expect(() => app.window("guard").pressClose()).rejects.toThrow('no window "guard" is open');
});

test("a window's picture needs a real platform, as the main window's does", async () => {
  const app = await open("./App.tsx", DESKTOP);
  await expect(() => app.window("notes").screenshot()).rejects.toThrow('no window "notes" is open');
  await app.press("Open notes");
  await app.waitFor("In notes");
  await expect(() => app.window("notes").screenshot()).rejects.toThrow("needs a real platform");
  await expect(() => app.window("main").screenshot()).rejects.toThrow("needs a real platform");
});

test("off the desktops an app has no windows of its own", async () => {
  const app = await open("./App.tsx", { platform: "ios" });
  expect(() => app.window("main").state()).toThrow("no windows of its own");
});
