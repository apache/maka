// The Charts demo: charts an app builds from `nsh/base/plot`'s parts and
// its own views. A live price streamed a tick a second that pauses and
// resumes, an order book's depth whose side under the pointer is read out
// and whose range changes, a drawdown whose day under the pointer is read
// out over both of its plots, capacity rings by period, a donut of revenue
// that reports the slice under the pointer (none in its hole) and closes
// into a pie, and sales as bars side by side or stacked.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  // A mouse to hover with, and a manual clock for the stream's ticks.
  app = await open("../App.tsx", { platform: "macos", width: 1200, height: 1700, clock: {} });
  await app.press("role:button[Charts]");
  await app.waitFor("Live price");
});

/** The live price's figure: the text right after the stream's state. */
const price = () => {
  const texts = app.texts();
  return texts[texts.findIndex((t) => t === "LIVE" || t === "PAUSED") + 1];
};

test("each chart is one image for screen readers", async () => {
  expect(app.count("role:image")).toBeGreaterThan(6);
});

test("the live price ticks every second until it is paused", async () => {
  const first = price();
  await app.clock.runFor(3000);
  expect(price()).not.toBe(first);
  await app.press("Pause");
  await app.waitFor("PAUSED");
  const paused = price();
  await app.clock.runFor(3000);
  expect(price()).toBe(paused);
  await app.press("Resume");
  await app.waitFor("LIVE");
});

test("the depth reads out the side under the pointer and changes its range", async () => {
  expect(app.texts()).toContain("99.58");
  await app.hover("label:/^Order book depth within 20 ticks/");
  await app.wait(100);
  expect(app.texts().some((t) => t.startsWith("BIDS ≥") || t.startsWith("ASKS ≤"))).toBe(true);
  await app.press("role:tab[40 ticks]");
  await app.waitFor("99.18");
});

test("the drawdown reads out the day under the pointer on either plot", async () => {
  expect(app.texts()).toContain("DAY 120");
  expect(app.texts()).toContain("at a high");
  await app.hover("label:/^Drawdown from the high/");
  await app.waitFor("DAY 60");
  expect(app.texts().some((t) => t.endsWith("% from the high"))).toBe(true);
});

test("the capacity rings show each period's load", async () => {
  expect(app.texts()).toContain("49%");
  await app.press("role:tab[7d peak]");
  await app.waitFor("88%");
  expect(app.texts()).toContain("92%");
});

test("a donut reports the slice under the pointer, none in its hole", async () => {
  const pie = "role:image[Revenue by region, $1.24M in all; largest North America at 38.9%]";
  // The middle of the donut is its hole: no slice, the total in it.
  await app.hover(pie);
  await app.wait(50);
  expect(app.texts()).toContain("TOTAL");
  // A whole pie: its middle is inside a slice (which one depends on where
  // the pointer lands within a point of it), its region in the middle.
  await app.press("Show as pie");
  await app.waitFor("Show as donut");
  await app.hover(pie);
  await app.waitFor("text:/^(NORTH AMERICA|EMEA|APAC|LATIN AMERICA|OTHER)$/");
});

test("bars stand in bands side by side or stacked, a value over each", async () => {
  // A value over each bar, the last month's total in the readout.
  expect(app.texts()).toContain("63");
  expect(app.texts()).toContain("33");
  expect(app.texts()).toContain("110k");
  // The pointer at the middle: April, the fourth of seven months.
  await app.hover("role:image[Sales per month, online and in store, highest in Jul]");
  await app.waitFor("96k");
  expect(app.texts()).toContain("Apr");
  // Stacked: the total over each stack, no value per bar.
  await app.press("role:tab[Stacked]");
  await app.waitFor("96");
  expect(app.texts()).not.toContain("63");
});
