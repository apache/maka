// Styles: a panel opens out of its corner with `clipPath`, and a wipe moves
// its edge between two photographs.
import { expect, open, test } from "nsh/test";

test("the clip path panel opens from its corner and the wipe moves", async () => {
  const app = await open("../App.tsx");
  await app.press("label:Styles");
  await app.waitFor("Clip path");
  expect(app.shows("inset(0 0 100% 100% round 16px)")).toBe(true);
  await app.press("text:+");
  await app.waitFor("inset(0 round 16px)");
  expect(app.shows("Open")).toBe(true);
  expect(app.shows("inset(0 70% 0 0)")).toBe(true);
  await app.press("id:wipe");
  await app.waitFor("inset(0 25% 0 0)");
});
