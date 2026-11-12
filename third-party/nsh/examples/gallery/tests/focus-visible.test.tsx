// `focus-visible:` shows the focus the keyboard moved, not the focus a
// press gave (as a browser's `:focus-visible`): a press that moves the
// focus (the app's `focus()`, a date picker's calendar opening at today)
// leaves the ring off, Tab and the keys put it on, and a key typed while
// the focus is unseen shows it; a tree's cursor, which the tree projects
// while it keeps the focus, shows it the same way. On a desktop, where Tab
// stops at the views that take presses.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("./fixtures/focus-visible.tsx", {
    platform: "macos",
    clock: { time: new Date(2026, 9, 28, 12) },
  });
  await app.waitFor("Target");
});

test("a press that moves the focus shows no ring, a key then does", async () => {
  await app.press("Focus the target");
  await app.wait(50);
  expect(app.shows("target ring")).toBe(false);
  // A key while it has the focus: the user is on the keyboard now.
  await app.keyboard.press("right");
  await app.waitFor("target ring");
});

test("Tab to the view shows its ring, and a press after it moves no focus", async () => {
  let tabs = 0;
  while (!app.shows("target ring")) {
    expect(++tabs).toBeLessThan(10);
    await app.keyboard.press("tab");
    await app.wait(50);
  }
  // Tab on: the ring goes with the focus.
  await app.keyboard.press("tab");
  await app.waitUntil(() => !app.shows("target ring"));
  // Back with the app's `focus()` after a press: no ring.
  await app.press("Focus the target");
  await app.wait(50);
  expect(app.shows("target ring")).toBe(false);
});

test("a date picker opened by a press puts the keyboard on today without a ring", async () => {
  await app.press("role:combobox[Due date]");
  await app.waitFor("label:2026-10-28");
  await app.wait(50);
  expect(app.shows("today ring")).toBe(false);
});

test("a date picker opened with the keyboard rings today", async () => {
  let tabs = 0;
  // Tab to the trigger, then Return opens the calendar at today.
  while (!app.shows("label:2026-10-28")) {
    expect(++tabs).toBeLessThan(10);
    await app.keyboard.press("tab");
    await app.keyboard.press("enter");
    await app.wait(50);
  }
  await app.waitFor("today ring");
});

test("a press on a tree's row puts the cursor there without a ring, an arrow key then rings it", async () => {
  await app.press("role:treeitem[Alpha]");
  await app.waitFor("Alpha cursor");
  await app.wait(50);
  expect(app.shows("Alpha ring")).toBe(false);
  // The keys move the cursor: the tree's focus shows, and so does the row.
  await app.keyboard.press("down");
  await app.waitFor("Beta ring");
  expect(app.shows("Beta cursor")).toBe(true);
  expect(app.shows("Alpha ring")).toBe(false);
});
