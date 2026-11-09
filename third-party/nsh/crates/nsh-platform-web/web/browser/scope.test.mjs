import test from "node:test";
import assert from "node:assert/strict";
import { configureAPIs } from "./scope.js";

test("desktop tray and global shortcuts retain their off-platform behavior", async () => {
  const desktop = {};
  const modules = { exports: new Map([["nsh/desktop", desktop]]) };
  configureAPIs({}, modules, {}, () => true, { titleBar: () => ({ height: 0 }) });
  assert.equal(desktop.isAvailable, false);
  desktop.Tray.set({ tooltip: "Gallery", menu: [] });
  desktop.Tray.set(null);
  let pressed = false;
  const registered = desktop.GlobalShortcut.register("ctrl+alt+k", () => { pressed = true; });
  assert.ok(registered instanceof Promise);
  assert.equal(await registered, false);
  desktop.GlobalShortcut.unregister("ctrl+alt+k");
  desktop.GlobalShortcut.unregisterAll();
  assert.equal(pressed, false);
});

test("the window API: the page is the main window, and no window of the app's own opens", () => {
  const desktop = {};
  const modules = { exports: new Map([["nsh/desktop", desktop]]) };
  const titleBar = () => ({ height: 0, left: 0, right: 0 });
  configureAPIs({}, modules, {}, () => true, { titleBar });
  const main = desktop.currentWindow();
  assert.equal(main.id, "main");
  assert.equal(main.main, true);
  assert.equal(main.state(), null);
  assert.deepEqual(main.titleBar(), { height: 0, left: 0, right: 0 });
  assert.deepEqual(desktop.windows(), [main]);
  assert.equal(desktop.Window.get("main"), main);
  assert.equal(desktop.Window.get("inspector"), null);
  assert.equal(desktop.focusedWindow(), null);
  assert.equal(desktop.windowState(), null);
  assert.deepEqual(desktop.displays(), []);
  assert.equal(desktop.Window({ id: "inspector" }), null);
  assert.throws(() => desktop.Window.open(() => null, { id: "inspector" }), { code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" });
  main.set({ title: "Report" });
  main.on("close", () => {})();
});
