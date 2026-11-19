// A scroll view's `keyboardShouldPersistTaps` at its default, "never": with
// the keyboard up, a tap only hides it and reaches nothing inside (no press,
// no responder release, no click in a web view); long presses and drags
// reach the views inside as they do with the keyboard down. A headless run
// shows no keyboard: its taps go through.
import { expect, open, test } from "nsh/test";

test("a tap in a scroll view hides the keyboard of a field below it", async () => {
  const app = await open("./fixtures/keyboard-taps.tsx");
  await app.type("id:message", "test1");
  const up = app.shows("text:keyboard: up");
  await app.press("text:/^Row 1/");
  await app.waitFor("text:keyboard: down");
  await app.wait(500);
  expect(app.texts()).toContain(up ? "Row 1, pressed 0" : "Row 1, pressed 1");
});

test("a long press in a scroll view goes through with the keyboard up", async () => {
  const app = await open("./fixtures/keyboard-taps.tsx");
  await app.type("id:message", "test1");
  const up = app.shows("text:keyboard: up");
  await app.longPress("text:/^Row 3/");
  await app.waitFor("text:Row 3, held 1");
  await app.wait(500);
  expect(app.texts()).toContain(up ? "keyboard: up" : "keyboard: down");
  expect(app.texts()).toContain("Row 1, pressed 0");
});

test("a held finger in a scroll view opens a context menu with the keyboard up", async () => {
  const app = await open("./fixtures/keyboard-taps.tsx");
  await app.type("id:message", "test1");
  await app.longPress("text:Row 2");
  await app.waitFor("text:menu-row");
});

test("a tap on a responder in a scroll view only hides the keyboard", async () => {
  const app = await open("./fixtures/keyboard-taps.tsx");
  await app.type("id:message", "test1");
  const up = app.shows("text:keyboard: up");
  // A finger that lands and lifts without moving: a tap on a view that hears no press.
  await app.drag("id:responder", { x: 0, y: 0 });
  await app.waitFor("text:keyboard: down");
  await app.wait(500);
  expect(app.texts()).toContain(up ? "Row 4, released 0" : "Row 4, released 1");
});

test("a tap on a web view in a scroll view only hides the keyboard", async () => {
  const app = await open("./fixtures/keyboard-taps.tsx");
  await app.type("id:message", "test1");
  // A phone's (a headless run shows no keyboard and no page).
  if (!app.shows("text:keyboard: up")) return;
  await app.waitFor("text:/web: ready/");
  await app.drag("id:web", { x: 0, y: 0 });
  await app.waitFor("text:keyboard: down");
  await app.wait(800);
  expect(app.shows("text:/web: ready/")).toBe(true);
  // With the keyboard down, the same tap clicks.
  await app.drag("id:web", { x: 0, y: 0 });
  await app.waitFor("text:/web: clicked/");
});

test("a drag in a scroll view scrolls it with the keyboard up", async () => {
  const app = await open("./fixtures/keyboard-taps.tsx");
  await app.type("id:message", "test1");
  const drags = () => Number(/^drags: (\d+)/.exec(app.texts().find((t) => t.startsWith("drags: ")) ?? "")?.[1]);
  const before = drags();
  await app.drag("text:/^Row 3/", { x: 0, y: -200 });
  await app.waitUntil(() => drags() > before);
});
