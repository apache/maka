// What the macOS test agent's input does to an app whose window is not the
// key window (its app runs in the background, `nsh test --target macos`;
// `--foreground` runs it as the active app, with the same outcomes):
// `nsh test crates/nsh-platform-macos/tests/host --target macos`.
// These tests are for the macOS host only: every test asserts that the app
// runs there (a web view takes trusted input only there), so a headless run
// or another target fails them.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

async function openFixture(): Promise<App> {
  const app = await open("./App.tsx");
  await app.waitFor("text:/^Trusted input: (true|false)$/");
  expect(app.shows("Trusted input: true")).toBe(true);
  return app;
}

test("a field takes typing and clear (Select All, then Backspace)", async () => {
  const app = await openFixture();
  await app.type("id:note", "hello");
  expect(app.value("id:note")).toBe("hello");
  await app.clear("id:note");
  expect(app.value("id:note")).toBe("");
});

test("Select All then typing replaces what the field holds", async () => {
  const app = await openFixture();
  await app.type("id:note", "hello");
  await app.keyboard.press("mod+a");
  // The field keeps the focus: typing again would press it and move the caret.
  await app.keyboard.press("x");
  expect(app.value("id:note")).toBe("x");
});

test("Command with Left and Backspace edit the field, which no menu item takes", async () => {
  const app = await openFixture();
  await app.type("id:note", "hello");
  await app.keyboard.press("mod+left");
  await app.keyboard.press("x");
  expect(app.value("id:note")).toBe("xhello");
  await app.keyboard.press("mod+right");
  await app.keyboard.press("mod+backspace");
  expect(app.value("id:note")).toBe("");
});

test("an app's shortcut fires with the field focused, and types nothing", async () => {
  const app = await openFixture();
  await app.type("id:note", "a");
  await app.keyboard.press("mod+k");
  await app.waitFor("Counted: 1");
  expect(app.value("id:note")).toBe("a");
});

test("a menu item's shortcut chooses it, a disabled item's does not", async () => {
  const app = await openFixture();
  await app.type("id:note", "a");
  await app.keyboard.press("mod+l");
  await app.wait(200);
  expect(app.shows("Menu: none")).toBe(true);
  await app.keyboard.press("mod+j");
  await app.waitFor("Menu: ping");
  expect(app.value("id:note")).toBe("a");
});

test("menu shortcuts without Command (Control, a function key) choose their items", async () => {
  const app = await openFixture();
  await app.type("id:note", "a");
  await app.keyboard.press("ctrl+j");
  await app.waitFor("Menu: ctrl-j");
  await app.keyboard.press("f5");
  await app.waitFor("Menu: f5");
  expect(app.value("id:note")).toBe("a");
});

test("a web view takes a click, typing and a key as trusted input", async () => {
  const app = await openFixture();
  await app.press("Click page");
  // The page handles a click on its own schedule: let it settle.
  await app.wait(300);
  await app.press("Type page");
  // `isTrusted` is the page's own reading of the events it got.
  await app.waitFor("Page: true:ab");
  await app.press("Backspace page");
  await app.waitFor("Page: true:a");
});

test("presses at one place count double and triple clicks, a press elsewhere starts again", async () => {
  const app = await openFixture();
  await app.press("Count here");
  await app.waitFor("Clicks: here 1");
  await app.press("Count here");
  await app.waitFor("Clicks: here 2");
  await app.press("Count here");
  await app.waitFor("Clicks: here 3");
  await app.press("Count there");
  await app.waitFor("Clicks: there 1");
});
