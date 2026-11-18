// The root gets the keyboard back when a focused view blurs or is removed
// and the window has no first responder left, but a focus transfer to a
// native input (or another view) keeps it.
import { expect, open, test } from "nsh/test";

test("blurring the focused view gives the root the keys back", async () => {
  const app = await open("./FocusTransfer.tsx");
  await app.press("id:pad");
  await app.waitFor("text:focus:pad");
  await app.press("id:blurPad");
  await app.waitFor("text:focus:none");
  // The root takes the keyboard back on the next turn.
  await app.wait(200);
  await app.keyboard.press("tab");
  await app.waitFor("text:focus:first");
});

test("deleting the focused view gives the root the keys back", async () => {
  const app = await open("./FocusTransfer.tsx");
  await app.press("id:pad");
  await app.waitFor("text:focus:pad");
  await app.press("id:removePad");
  await app.wait(300);
  await app.keyboard.press("tab");
  await app.waitFor("text:focus:first");
});

test("a native input keeps the focus through the root recovery turn", async () => {
  const app = await open("./FocusTransfer.tsx");
  await app.press("id:pad");
  await app.waitFor("text:focus:pad");
  // The input becomes first responder as the pad resigns: the deferred
  // root recovery must see it and leave the focus there.
  await app.type("id:field", "ab");
  await app.waitFor("text:focus:field");
  await app.waitFor("text:input:ab");
  await app.wait(300);
  expect(app.shows("text:focus:field")).toBe(true);
  await app.keyboard.press("a");
  await app.waitFor("text:input:aba");
  expect(app.shows("text:focus:field")).toBe(true);
});
