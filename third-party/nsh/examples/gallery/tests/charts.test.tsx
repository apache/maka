// The Charts demo: `nsh/base/plot`'s `Plot` with a line, an area and grid
// lines over a week of visitors, the row under the pointer reported (the
// cross line, dots and tooltip are the plot's parts), another week drawn
// in, sales per month as bars side by side or stacked with a value over
// each, a donut of revenue by region that turns into a pie and reports the
// slice under the pointer, and a list of sparklines, one plot per row,
// that follow no pointer.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  // A mouse to hover with: the desktop.
  app = await open("../App.tsx", { platform: "macos", width: 1200, height: 1700, clock: {} });
  await app.press("role:button[Charts]");
  await app.waitFor("Sun, the last day");
});

test("a plot is one image for screen readers and reports the day under the pointer", async () => {
  // The week's plot and a sparkline per row the list made.
  expect(app.count("role:image")).toBeGreaterThan(1);
  expect(app.texts()).toContain("1,180 visitors");
  await app.hover("role:image[Visitors per day, from 1,820 on Monday to 1,180 on Sunday]");
  // The pointer at the middle: Thursday, the fourth of seven days.
  await app.waitFor("Plot: Thu, 2,480");
  expect(app.texts()).toContain("2,480 visitors");
});

test("another week draws the plot again with its rows", async () => {
  await app.press("Show this week");
  await app.waitFor("Plot: this week");
  expect(app.texts()).toContain("This week");
  expect(app.texts()).toContain("1,330 visitors");
  await app.press("Show last week");
  await app.waitFor("Plot: last week");
  expect(app.texts()).toContain("1,180 visitors");
});

test("bars stand in bands side by side or stacked, a value over each", async () => {
  // A value over each bar, the last month's in the caption.
  expect(app.texts()).toContain("63");
  expect(app.texts()).toContain("33");
  expect(app.texts()).toContain("110k in all");
  // The pointer at the middle: April, the fourth of seven months.
  await app.hover("role:image[Sales per month, online and in store, highest in Jul]");
  await app.waitFor("Bars: Apr, 96k");
  expect(app.texts()).toContain("96k in all");
  // Stacked: the total over each stack, no value per bar.
  await app.press("role:tab[Stacked]");
  await app.waitFor("Bars: stacked");
  await app.waitFor("96");
  expect(app.texts()).not.toContain("63");
});

test("the sparklines are rows of a list, each a plot of its own", async () => {
  expect(app.texts()).toContain("NSHL");
  expect(app.count("role:image")).toBeGreaterThan(4);
});

test("a pie reports the slice under the pointer, none in a donut's hole", async () => {
  const pie = "role:image[Revenue by region, $1.24M in all; largest North America at 38.9%]";
  expect(app.texts()).toContain("North America");
  // The middle of the donut is its hole: no slice.
  await app.hover(pie);
  await app.wait(50);
  expect(app.texts()).not.toContain("Pie: North America, $482k");
  // A whole pie: its middle reads as 3 o'clock, inside the first slice.
  await app.press("Show as pie");
  await app.waitFor("Pie: pie");
  await app.hover(pie);
  await app.waitFor("Pie: North America, $482k");
  await app.press("Show as donut");
  await app.waitFor("Pie: donut");
});
