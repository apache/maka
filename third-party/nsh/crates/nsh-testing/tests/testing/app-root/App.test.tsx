import { expect, open, test } from "nsh/test";

test("a desktop app root that returns a view renders in the implicit first window", async () => {
  const app = await open("./App.tsx", { platform: "macos" });
  expect(app.shows("No window")).toBe(true);
  // titleBar() reads the implicit window in the app root.
  expect(app.shows("Bar: 0")).toBe(true);
  expect(app.windowIds()).toEqual(["main"]);
});

test("a desktop app root that declares no Window gets the implicit first window", async () => {
  const app = await open("./Empty.tsx", { platform: "macos" });
  expect(app.windowIds()).toEqual(["main"]);
});

test("off the desktops the same view is the one surface", async () => {
  const app = await open("./App.tsx", { platform: "ios" });
  expect(app.shows("No window")).toBe(true);
});

test("closing the implicit main window quits on macOS by default", async () => {
  const app = await open("./App.tsx", { platform: "macos" });
  expect(app.quit()).toBe(false);
  await app.window("main").pressClose();
  await app.waitUntil(() => app.window("main").state() === null);
  expect(app.quit()).toBe(true);
});

test("an implicit main window respects Application.setQuitMode(\"platform\")", async () => {
  const app = await open("./PlatformQuit.tsx", { platform: "macos" });
  await app.window("main").pressClose();
  await app.waitUntil(() => app.window("main").state() === null);
  expect(app.quit()).toBe(false);
});

test("an implicit main window respects nsh.json application.quitMode", async () => {
  const app = await open("./configured/App.tsx", { platform: "macos" });
  await app.window("main").pressClose();
  await app.waitUntil(() => app.window("main").state() === null);
  expect(app.quit()).toBe(false);
});

test("titleBar() and windowState() read main outside a render", async () => {
  const app = await open("./App.tsx", { platform: "macos", width: 800, height: 600 });
  await app.press("Read outside");
  await app.waitFor("Outside: sync 0 800, async 0 800");
});

test("closing a window does not throw in an effect reading windowState() and titleBar()", async () => {
  const app = await open("./CloseEffect.tsx", { platform: "macos", width: 640, height: 480 });
  await app.waitUntil(async () => (await app.storage())["close.state"] === "640 0");
  await app.window("main").pressClose();
  await app.waitUntil(() => app.window("main").state() === null);
  await app.waitUntil(async () => (await app.storage())["close.state"] === "null 0");
});
