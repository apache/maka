// Run with --target ios to exercise UIKit's hardware-key responder chain.
import { expect, open, test } from "nsh/test";

test("shortcuts work before input focus and after input submission", async () => {
  const app = await open("./fixtures/shortcut-no-focus.tsx");
  await app.waitFor("text:shortcut: 0");
  await app.keyboard.press("k");
  await app.waitFor("text:shortcut: 1");
  await app.type("id:field", "note");
  await app.keyboard.press("k");
  expect(app.value("id:field")).toBe("notek");
  await app.submit("id:field");
  await app.keyboard.press("k");
  await app.waitFor("text:shortcut: 2");
});

test("dismissing with no input focused keeps shortcuts working", async () => {
  const app = await open("./fixtures/shortcut-no-focus.tsx");
  await app.waitFor("text:shortcut: 0");
  // The root itself is first responder. There is no input blur callback
  // to restore it after Keyboard.dismiss() ends editing in the surface.
  await app.keyboard.press("d");
  await app.waitFor("text:dismissed: 1");
  await app.keyboard.press("k");
  await app.waitFor("text:shortcut: 1");
  await app.keyboard.press("d");
  await app.waitFor("text:dismissed: 2");
  await app.keyboard.press("k");
  await app.waitFor("text:shortcut: 2");
});
