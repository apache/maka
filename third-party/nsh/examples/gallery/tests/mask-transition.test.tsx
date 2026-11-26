// Styles: a `maskImage` fade grows in from the bottom edge.
import { expect, open, test } from "nsh/test";

test("the mask fades in and back", async () => {
  const app = await open("../App.tsx");
  await app.press("label:Styles");
  await app.waitFor("Mask");
  expect(app.shows("black 100%, transparent 100%")).toBe(true);
  await app.press("id:fade");
  await app.waitFor("black 40%, transparent 100%");
  expect(app.shows("Faded")).toBe(true);
  await app.press("id:fade");
  await app.waitFor("black 100%, transparent 100%");
});
