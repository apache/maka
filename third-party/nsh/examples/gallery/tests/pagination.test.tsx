// The Pagination demo: search results paged with a count, a table's footer
// whose page size keeps the first row in view, a compact chapter pager and
// an archive of ten thousand pages that goes offline. Each pagination
// reports the page picked and shows the one the demo passes back.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("../App.tsx", { clock: {} });
  await app.press("role:button[Pagination]");
  await app.waitFor("Showing 1–10 of 238");
});

test("the results page with Next, a page, and stop at the last", async () => {
  expect(app.count("role:navigation[Search results pages]")).toBe(1);
  expect(app.enabled("label:Previous")).toBe(false);
  await app.press("label:Next");
  await app.waitFor("Showing 11–20 of 238");
  await app.waitFor("Result 11: Native views for generated UI");
  await app.press("role:button[24]");
  await app.waitFor("Showing 231–238 of 238");
  expect(app.enabled("label:Next")).toBe(false);
  expect(app.enabled("label:Previous")).toBe(true);
});

test("a new page size keeps the first row shown on the page", async () => {
  await app.press("label:Older");
  await app.waitFor("Rows 26–50 of 1,284");
  await app.press("role:tab[10]");
  // Row 26 is on page 3 of ten rows.
  await app.waitFor("Rows 21–30 of 1,284");
  await app.waitFor("129 pages");
});

test("the compact pager turns the chapters", async () => {
  expect(app.enabled("label:Previous chapter")).toBe(false);
  await app.press("label:Next chapter");
  await app.waitFor("2 / 12");
  await app.waitFor("The Harbor");
  await app.press("label:Previous chapter");
  await app.waitFor("1 / 12");
});

test("ten thousand pages reach the last, and nothing takes a press offline", async () => {
  await app.waitFor("Page 5,000 of 10,000");
  await app.press("label:Next archive page");
  await app.waitFor("onChange({ page: 5001 })");
  await app.press("role:button[Last page]");
  await app.waitFor("Page 10,000 of 10,000");
  expect(app.enabled("label:Next archive page")).toBe(false);
  await app.press("label:Offline");
  await app.waitFor("Offline: no presses, no focus, dimmed for screen readers");
  expect(app.enabled("label:Previous archive page")).toBe(false);
  expect(app.enabled("role:button[9,999]")).toBe(false);
});
