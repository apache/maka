// The hardware keyboard on a focusable view: one typed KeyDown/KeyUp per
// UIPress transition (the source's key with its case, the DOM code from the
// key's HID usage, modifiers, no invented repeat), a mounted capture rule
// taking the key before the default, the root's initial Tab entrypoint and
// our focus moves. The simulator injects real IOHID key events.
import { expect, open, test } from "nsh/test";

test("tab from the window's initial focus reaches the first stop", async () => {
  // Nothing has the keyboard focus yet: the surface root is first responder
  // and its Tab entrypoint moves to the first stop, as UIKit would with an
  // initial focus.
  const app = await open("./App.tsx");
  await app.keyboard.press("tab");
  await app.waitFor("text:focus:first");
});

test("shift+tab from the window's initial focus reaches the last stop", async () => {
  const app = await open("./App.tsx");
  await app.keyboard.press("shift+tab");
  await app.waitFor("text:focus:scrollChild");
});

test("a focused view reports a hardware press and release with the source's data", async () => {
  const app = await open("./App.tsx");
  await app.press("id:first");
  await app.waitFor("text:focus:first");
  await app.keyboard.press("a");
  await app.waitFor("text:key:a");
  expect(app.shows("text:code:KeyA")).toBe(true);
  expect(app.shows("text:prevented:false")).toBe(true);
  expect(app.shows("text:mods:none")).toBe(true);
  expect(app.shows("text:repeat:once")).toBe(true);
  await app.waitFor("text:up:a");
  expect(app.shows("text:upPrevented:false")).toBe(true);
});

test("shift keeps the source key's case and reports the modifier", async () => {
  const app = await open("./App.tsx");
  await app.press("id:first");
  await app.waitFor("text:focus:first");
  await app.keyboard.press("shift+a");
  await app.waitFor("text:key:A");
  expect(app.shows("text:code:KeyA")).toBe(true);
  expect(app.shows("text:mods:shift")).toBe(true);
  expect(app.shows("text:prevented:false")).toBe(true);
});

test("a capture rule takes the key before the default", async () => {
  const app = await open("./App.tsx");
  await app.press("id:second");
  await app.waitFor("text:focus:second");
  await app.keyboard.press("a");
  await app.waitFor("text:key:a");
  expect(app.shows("text:prevented:true")).toBe(true);
});

test("tab moves between focusable views", async () => {
  const app = await open("./App.tsx");
  await app.press("id:first");
  await app.waitFor("text:focus:first");
  await app.keyboard.press("tab");
  await app.waitFor("text:focus:second");
  await app.keyboard.press("tab");
  await app.waitFor("text:focus:third");
});

test("a captured tab stays in the focused view", async () => {
  const app = await open("./App.tsx");
  await app.press("id:capturedTab");
  await app.waitFor("text:focus:capturedTab");
  // The view's mounted rule captures Tab before UIKit's focus traversal
  // and reports it prevented. A real UIPress keeps its Tab identity; a
  // UIKeyCommand carrying the same key has no HID usage, so `code` is not
  // asserted either way.
  await app.keyboard.press("tab");
  await app.waitFor("text:prevented:true");
  expect(app.shows("text:key:Tab")).toBe(true);
  expect(app.shows("text:repeat:once")).toBe(true);
  expect(app.shows("text:focus:capturedTab")).toBe(true);
});

test("Return presses the focused view that takes presses", async () => {
  const app = await open("./App.tsx");
  await app.press("id:first");
  await app.waitFor("text:focus:first");
  // The tap that focused the view is its first press.
  await app.waitFor("text:pressed:1");
  await app.keyboard.press("enter");
  await app.waitFor("text:pressed:2");
});

test("a focusable view without onPress takes focus on a tap", async () => {
  const app = await open("./App.tsx");
  // A real touch: `press` needs a pressable view, and this one has no
  // press handlers (the focus tap recognizer must not claim the touch).
  await app.drag("id:noPress", { x: 0, y: 0 });
  await app.waitFor("text:focus:noPress");
  await app.keyboard.press("a");
  await app.waitFor("text:key:a");
  expect(app.shows("text:prevented:false")).toBe(true);
});

test("a scroll view ancestor hears and captures a focused child's key", async () => {
  const app = await open("./App.tsx");
  await app.drag("id:scrollChild", { x: 0, y: 0 });
  await app.waitFor("text:focus:scrollChild");
  await app.keyboard.press("a");
  await app.waitFor("text:scrollKey:a");
  await app.waitFor("text:scrollPrevented:true");
  expect(app.shows("text:focus:scrollChild")).toBe(true);
});

test("a portal notifies and captures its logical ancestor", async () => {
  const app = await open("./App.tsx");
  await app.press("id:openPortalsA");
  await app.waitFor("id:childA");
  await app.press("id:childA");
  await app.waitFor("text:focus:childA");
  await app.keyboard.press("a");
  await app.waitFor("text:hostAKey:a");
  await app.waitFor("text:hostAPrevented:true");
  await app.waitFor("text:hostACount:1");
});

test("a sibling portal does not capture another portal's ancestor", async () => {
  const app = await open("./App.tsx");
  await app.press("id:openPortalsB");
  await app.waitFor("id:childB");
  await app.press("id:childB");
  await app.waitFor("text:focus:childB");
  await app.keyboard.press("a");
  await app.waitFor("text:childBKey:a");
  await app.waitFor("text:childBPrevented:false");
  expect(app.shows("text:hostACount:0")).toBe(true);
});

test("shift+tab moves the focus back", async () => {
  const app = await open("./App.tsx");
  await app.press("id:second");
  await app.waitFor("text:focus:second");
  await app.keyboard.press("shift+tab");
  await app.waitFor("text:focus:first");
});
