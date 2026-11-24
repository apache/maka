import { expect, open, test } from "nsh/test";

test("a comment before an If's function child keeps its accessor", async () => {
  const app = await open("./App.tsx");
  await app.press("Before");
  expect(app.shows("Said: before ada")).toBe(true);
});

test("a comment after an If's function child keeps its accessor", async () => {
  const app = await open("./App.tsx");
  await app.press("After");
  expect(app.shows("Said: after ada")).toBe(true);
});

test("comments around an Each's function child keep its accessor", async () => {
  const app = await open("./App.tsx");
  await app.press("Item");
  expect(app.shows("Said: item one")).toBe(true);
});
