import { open, test } from "nsh/test";

test("reveal scrolls every scroll view around a view", async () => {
  const app = await open("./fixtures/reveal.tsx");
  await app.waitFor("text:outer 0 inner 0");
  await app.press("Show cell");
  // Row 6 at the outer view's start; the last cell's end at the inner one's.
  await app.waitFor("text:outer 600 inner 700");
});
