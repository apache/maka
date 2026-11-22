// A long recycled list: scrolling binds the rows that come into view.
import { expect, open, test } from "nsh/test";

test("scrolling the list shows the rows further down", async () => {
  const app = await open("../App.tsx", { clock: {} });
  await app.press("label:Photos");
  await app.waitFor("Ridge 0001");
  // The rows are buttons, found inside the list.
  expect(app.count("id:photos >> role:button")).toBeGreaterThan(5);
  expect(app.shows("Dunes 0030")).toBe(false);
  await app.scroll("id:photos", 2400);
  await app.waitFor("Dunes 0030");
});
