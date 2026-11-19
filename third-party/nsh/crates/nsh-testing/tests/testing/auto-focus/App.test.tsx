import { expect, open, test } from "nsh/test";

test("a field that asks for the focus has it once it mounts", async () => {
  const app = await open("./App.tsx");
  await app.waitFor("Focus: search");
  // The keys go to it without a step that names it.
  await app.keyboard.press("enter");
  await app.waitFor("Submitted: search");
});

test("a field mounted later that asks for the focus takes it", async () => {
  const app = await open("./App.tsx");
  await app.waitFor("Focus: search");
  await app.press("Open");
  await app.waitFor("Focus: palette");
  await app.keyboard.press("enter");
  await app.waitFor("Submitted: palette");
});

test("a field that does not ask for the focus is left without it", async () => {
  const app = await open("./Plain.tsx");
  await app.wait(100);
  expect(app.shows("Focus: none")).toBe(true);
  await app.keyboard.press("enter");
  expect(app.shows("Focus: none")).toBe(true);
});
