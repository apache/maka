// The Overlays demo's toasts on a phone (headless runs are touch screens):
// the gallery's `toast()` (`toast.tsx`, on `nsh/base`'s `ToastManager`,
// `ToastStack` and `Toast`) from a button, shown by its `Toaster`; they
// close by themselves, by their action, by back (the stack's `onCancel`),
// and by `dismissToast`; a swipe takes one away (the toast's
// `onDismissRequest`). Then on a desktop: the pointer on the stack expands
// it and stops the time.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("../App.tsx", { clock: {} });
  await app.press("role:button[Overlays]");
  await app.waitFor("Copy the link");
});

test("a toast shows, then closes when its time runs out", async () => {
  await app.press("Copy the link");
  await app.waitFor("Copied");
  await app.waitFor("The link is on the clipboard (1)");
  await app.wait(4000);
  expect(app.texts()).toContain("Copied");
  // In 400 ms, 5 s there, out in 200 ms.
  await app.wait(1800);
  expect(app.texts()).not.toContain("Copied");
});

test("its action closes it and answers its show", async () => {
  await app.press("Delete the draft");
  await app.waitFor("Draft deleted");
  await app.press("Undo");
  // Its exit's time (the gallery's 200 ms) on the test's clock.
  await app.wait(300);
  await app.waitFor("toast: undone");
  expect(app.texts()).not.toContain("Draft deleted");
});

test("its close button, back and dismissToast close toasts", async () => {
  await app.press("Delete the draft");
  await app.waitFor("Draft deleted");
  await app.press("×");
  await app.wait(300);
  await app.waitFor("toast: gone");
  await app.press("Copy the link");
  await app.waitFor("Copied");
  await app.back();
  await app.wait(300);
  expect(app.texts()).not.toContain("Copied");
  await app.press("Copy the link");
  await app.press("Copy the link");
  await app.waitFor("The link is on the clipboard (2)");
  await app.waitFor("The link is on the clipboard (3)");
  await app.press("Dismiss all");
  await app.wait(300);
  expect(app.texts()).not.toContain("Copied");
});

test("at most three show at once, the older ones waiting", async () => {
  for (let i = 0; i < 4; i++) await app.press("Copy the link");
  await app.waitFor("The link is on the clipboard (4)");
  expect(app.texts()).not.toContain("The link is on the clipboard (1)");
  await app.press("Dismiss all");
  await app.wait(300);
  expect(app.texts()).not.toContain("Copied");
});

test("a swipe takes a toast away", async () => {
  await app.press("Copy the link");
  await app.waitFor("Copied");
  await app.drag("Copied", { x: 120, y: 0 });
  await app.wait(300);
  expect(app.texts()).not.toContain("Copied");
});

test("on a desktop, the pointer on a toast stops its time", async () => {
  const desk = await open("../App.tsx", { platform: "macos", clock: {} });
  await desk.press("role:button[Overlays]");
  await desk.waitFor("Copy the link");
  await desk.press("Copy the link");
  await desk.waitFor("Copied");
  await desk.hover("Copied");
  await desk.wait(8000);
  expect(desk.texts()).toContain("Copied");
  await desk.hover("Copy the link");
  await desk.wait(5600);
  expect(desk.texts()).not.toContain("Copied");
});
