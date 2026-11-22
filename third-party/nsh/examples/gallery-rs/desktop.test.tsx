// The desktop layout of wide windows: a sidebar of the demos and the
// selected one in a pane beside it; the phone layout below 700 pt, what is
// open carrying over.
import { expect, open, test } from "nsh/test";

const STOCKS = "A live watchlist and a stock: candles, depth, the tape, a tick every 50 ms";
const PHOTOS = "A long recycled list: images, pull to refresh, paging";
const FOOTER = "Narrower than 700 pt: the phone layout";

test("the sidebar shows the selected demo in the pane", async () => {
  const app = await open(".", { clock: {}, width: 1200, height: 800 });
  for (const text of [
    "Rust Gallery",
    "APPS",
    "PLATFORM",
    "System",
    "1200 × 800 pt",
    FOOTER,
    // The first demo, under its name, what it shows and its group.
    STOCKS,
    "Apps",
    "Composite",
  ]) {
    expect(app.texts()).toContain(text);
  }
  // No index to go back to: the pane's demo is no pushed screen.
  await expect(() => app.back()).rejects.toMatchObject({ code: "ERR_NSH_TEST_NO_BACK" });
  await app.press("label:Photos");
  await app.waitFor(PHOTOS);
  expect(app.texts()).toContain("Photo stream");
  expect(app.shows(STOCKS)).toBe(false);
});

test("resizing switches layouts and keeps the open demo", async () => {
  const app = await open(".", { clock: {}, width: 1200, height: 800 });
  await app.press("label:Photos");
  await app.waitFor(PHOTOS);
  // The phone layout: the demo pushed over the index, no sidebar.
  await app.setViewport(390, 844);
  await app.waitFor("1,000 photos");
  expect(app.shows(FOOTER)).toBe(false);
  await app.back();
  await app.waitFor("APPS");
  await app.press("label:Photos");
  // Back to the desktop layout: the demo the phone had open.
  await app.setViewport(1200, 800);
  await app.waitFor(FOOTER);
  expect(app.texts()).toContain(PHOTOS);
  expect(app.texts()).toContain("Photo stream");
  await expect(() => app.back()).rejects.toMatchObject({ code: "ERR_NSH_TEST_NO_BACK" });
});
