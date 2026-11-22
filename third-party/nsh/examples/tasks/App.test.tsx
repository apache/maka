// The app's flows, with the steps a user takes.
import { expect, open, test } from "nsh/test";

test("adds a task, and a blank title cannot be added", async () => {
  const app = await open("./App.tsx");
  expect(app.enabled("role:button[Add]")).toBe(false);
  await app.type("text:New task", "Ship it");
  await app.press("role:button[Add]");
  await app.waitFor("Ship it");
  expect(app.value("text:New task")).toBe("");
});

test("a task's switch changes the list behind it", async () => {
  const app = await open("./App.tsx");
  await app.press("Write the first page");
  await app.waitFor("role:switch");
  await app.press("role:switch");
  await app.back();
  await app.waitFor("role:button[Write the first page Done]");
});

test("removing asks first, and only Remove removes", async () => {
  const app = await open("./App.tsx");
  await app.press("Read the coding guides");
  await app.waitFor("role:button[Remove]");
  app.onDialog((dialog) => {
    expect(dialog.title).toBe("Remove this task?");
    return "Remove";
  });
  await app.press("role:button[Remove]");
  await app.waitFor("Read the coding guides", { state: "gone" });
  expect(app.dialogs().length).toBe(1);
});
