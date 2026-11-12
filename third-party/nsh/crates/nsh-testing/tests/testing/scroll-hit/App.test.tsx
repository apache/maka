import { expect, open, test } from "nsh/test";

test("a press on a button across a scroll view's fold reaches it", async () => {
  const app = await open("./App.tsx");
  await app.press("id:probe-toggle");
  expect(app.shows("Pressed: toggle")).toBe(true);
});

test("a button wholely above the fold takes its press", async () => {
  const app = await open("./App.tsx");
  await app.press("id:probe-visible");
  expect(app.shows("Pressed: visible")).toBe(true);
});
