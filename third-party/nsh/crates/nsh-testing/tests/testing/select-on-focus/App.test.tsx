import { expect, open, test } from "nsh/test";

test("focus() selects the whole text of a field that asks for it", async () => {
  const app = await open("./App.tsx");
  await app.press("Focus");
  await app.waitFor("text:select: 0-5");
  expect(app.shows("text:plain: none")).toBe(true);
});

test("typing into a field that selects on focus replaces its text", async () => {
  const app = await open("./App.tsx");
  await app.type("id:select", "Bye");
  await app.waitFor("text:select: 3-3");
  expect(app.value("id:select")).toBe("Bye");
  await app.type("id:plain", "!");
  await app.waitFor("text:plain: 6-6");
  expect(app.value("id:plain")).toBe("Hello!");
  // Focused again, it selects its text again.
  await app.type("id:select", "Hi");
  await app.waitFor("text:select: 2-2");
  expect(app.value("id:select")).toBe("Hi");
});
