import { expect, open, test } from "nsh/test";

test("back pops the screen pushed last", async () => {
  const app = await open("./App.tsx");
  await app.press("Open");
  await app.waitFor("Detail body");
  await app.back();
  expect(app.shows("Detail body")).toBe(false);
  expect(app.texts()).toContain("Answer: none");
  await expect(() => app.back()).rejects.toMatchObject({ code: "ERR_NSH_TEST_NO_BACK" });
});

test("a screen that prevents going back is asked", async () => {
  const app = await open("./App.tsx");
  await app.press("Draft");
  await app.back();
  await app.waitFor("Asked: yes");
});

test("back closes a modal", async () => {
  const app = await open("./App.tsx");
  await app.press("Sheet");
  await app.waitFor("In the sheet");
  expect(app.texts()).toContain("Shown: 1");
  await app.back();
  expect(app.shows("In the sheet")).toBe(false);
});

test("a dialog is cancelled unless the test answers it", async () => {
  const app = await open("./App.tsx");
  await app.press("Delete");
  await app.waitFor("Answer: cancel");
  expect(app.dialogs()[0].message).toBe("It is gone after.");
  app.onDialog((dialog) => (dialog.title === "Delete?" ? "Delete" : null));
  await app.press("Delete");
  await app.waitFor("Answer: delete");
  // Closing it without a button is the user's choice only when it can be.
  await expect(() => app.press("Update")).rejects.toThrow("cannot be dismissed");
});

test("a dialog without a cancel button needs an answer", async () => {
  const app = await open("./App.tsx");
  await expect(() => app.press("Update")).rejects.toThrow("needs an answer");
});

test("the clipboard holds what was copied", async () => {
  const app = await open("./App.tsx", { clipboard: "seed" });
  await app.press("Paste");
  await app.waitFor("Pasted: seed");
  await app.press("Copy");
  expect(app.clipboard()).toBe("copied text");
});

test("native animations run to their end", async () => {
  const app = await open("./App.tsx");
  await app.press("Move");
  await app.waitFor("Moved: done");
});

test("an image's size is answered as a failed load", async () => {
  const app = await open("./App.tsx");
  await app.press("Measure");
  await app.waitFor("Size: not loaded");
});

test("focus() gives a view that takes presses the keyboard focus where Tab stops at it", async () => {
  const app = await open("./App.tsx", { platform: "macos" });
  await app.press("Focus it");
  await app.waitFor("Key focus: focused");
  // Return presses the view the focus is on, and its blur() lets it go.
  await app.keyboard.press("enter");
  await app.waitFor("Key focus: focused blurred");
});

test("focus() leaves views that take presses alone where Tab skips them", async () => {
  const app = await open("./App.tsx");
  await app.press("Focus it");
  await app.wait(100);
  expect(app.texts()).toContain("Key focus: none");
});
