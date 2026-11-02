// The Toast demo on a phone (headless runs are touch screens):
// the gallery's `toast()` (`toast.tsx`, on `nsh/base`'s `ToastManager`,
// `ToastStack` and `Toast`) from a button, shown by its `Toaster`; they
// close by themselves, by their action, by their close button, by back
// (the stack's `onCancel`) and by `dismissToast`; a swipe takes one away
// (the toast's `onDismissRequest`); `updateToast` turns a loading toast
// into its result in place. Then on a desktop: the pointer on the stack
// expands it and stops the time.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("../App.tsx", { clock: {} });
  await app.press("role:button[Toast]");
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

test("an undo restores what was archived, and answers its show", async () => {
  await app.press("label:Archive Lunch on Friday?");
  await app.waitFor("Conversation archived");
  await app.waitFor("label:Archive Lunch on Friday?", { state: "gone" });
  await app.press("Undo");
  // Its exit's time (the gallery's 200 ms) on the test's clock.
  await app.wait(300);
  await app.waitFor("archive Lunch on Friday?: undone");
  await app.waitFor("label:Archive Lunch on Friday?");
  expect(app.texts()).not.toContain("Conversation archived");
});

test("its close button, back and dismissToast close toasts", async () => {
  await app.press("label:Archive Invoice for October");
  await app.waitFor("Conversation archived");
  await app.press("label:Dismiss");
  await app.wait(300);
  await app.waitFor("archive Invoice for October: kept");
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

test("an error's retry becomes a loading toast, then its result", async () => {
  await app.press("Send a message");
  await app.waitFor("Couldn't send the message");
  await app.press("role:button[Retry]");
  // The error leaves (its exit transition on the test's clock), then the
  // loading toast takes its place.
  await app.wait(600);
  await app.waitFor("error toast: Retry");
  await app.waitFor("Sending…");
  await app.wait(1300);
  await app.waitFor("Message sent");
});

test("a loading toast counts its progress, then becomes its result in place", async () => {
  await app.press("Upload 3 photos");
  await app.waitFor("0 of 3");
  await app.wait(750);
  await app.waitFor("1 of 3");
  await app.wait(1700);
  await app.waitFor("3 photos uploaded");
  // Its new time: 4 s, then gone.
  await app.wait(4500);
  expect(app.texts()).not.toContain("3 photos uploaded");
});

test("a failed upload offers a retry, which starts it again", async () => {
  await app.press("role:switch[Fail the last one]");
  await app.press("Upload 3 photos");
  await app.wait(2200);
  await app.waitFor("Upload failed");
  await app.waitFor("2 of 3 uploaded");
  await app.press("Retry");
  await app.wait(300);
  await app.waitFor("upload toast: Retry");
  await app.waitFor("0 of 3");
});

test("on a desktop, the pointer on a toast stops its time", async () => {
  const desk = await open("../App.tsx", { platform: "macos", clock: {} });
  await desk.press("role:button[Toast]");
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
