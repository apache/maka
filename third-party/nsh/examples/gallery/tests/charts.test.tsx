// The Charts demo: charts an app builds from `nsh/base/plot`'s parts and
// its own views. A live price streamed a tick a second that pauses and
// resumes, its window's high written over it and its last price tagged, an order book's depth whose side under the pointer is read out
// and whose range changes, a drawdown whose day under the pointer or the
// arrow keys is read out over both of its plots, capacity rings by period,
// a donut of revenue that reports the slice under the pointer (none in its
// hole) or the arrow keys and closes into a pie with its shares written
// outside, sales as bars side by side or stacked, a radar of factor
// exposure that reads out the factor nearest the pointer and changes its
// benchmark, a quarter's income as flows between its accounts, read out
// under the arrow keys and moving into the next quarter's, and a
// watchlist whose sparklines come with their rows as its list scrolls and
// show each period.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
/** The Charts page with a mouse to hover with and a manual clock for the stream's ticks. */
const start = async (reducedMotion = false) => {
  app = await open("../App.tsx", { platform: "macos", width: 1200, height: 1700, clock: {}, reducedMotion });
  await app.press("role:button[Plot]");
  await app.waitFor("Live price");
};
beforeEach(() => start());

/** The live price's figure: the text right after the stream's state. */
const price = () => {
  const texts = app.texts();
  return texts[texts.findIndex((t) => t === "LIVE" || t === "PAUSED") + 1];
};

/**
 * Tabs on, pressing Right at each stop, until `shown` is on screen: the
 * first plot that reads it out has the focus. With reduced motion: in a
 * desktop window a step waits for the page to settle, which the live
 * price's pulse never does. The sidebar's stops (its toggle, its search,
 * its demos as one stop, the appearance) come after the page among the
 * views, which stack the sidebar above it; AppKit orders its key view
 * loop by position, which mixes them in with the page's.
 */
const tabTo = async (shown: string) => {
  await start(true);
  let tabs = 0;
  while (!app.shows(shown)) {
    expect(++tabs).toBeLessThan(30);
    await app.keyboard.press("tab");
    await app.keyboard.press("right");
    await app.wait(50);
  }
};

test("each chart is one image for screen readers", async () => {
  expect(app.count("role:image")).toBeGreaterThan(6);
});

test("the live price ticks every second until it is paused", async () => {
  const first = price();
  await app.clock!.runFor(3000);
  expect(price()).not.toBe(first);
  await app.press("Pause");
  await app.waitFor("PAUSED");
  const paused = price();
  await app.clock!.runFor(3000);
  expect(price()).toBe(paused);
  await app.press("Resume");
  await app.waitFor("LIVE");
});

test("the live price writes its window's high over it and tags its last price", async () => {
  const after = (label: string) => {
    const texts = app.texts();
    return texts[texts.indexOf(label) + 1];
  };
  // Over the line, the high the figures under it read; at the line's end,
  // the price the card's figure reads.
  expect(app.texts()).toContain(`High ${after("HIGH")}`);
  expect(app.texts().filter((t) => t === price()).length).toBeGreaterThanOrEqual(2);
  await app.clock!.runFor(3000);
  expect(app.texts()).toContain(`High ${after("HIGH")}`);
  expect(app.texts().filter((t) => t === price()).length).toBeGreaterThanOrEqual(2);
});

test("the depth reads out the side under the pointer and changes its range", async () => {
  // The ends' prices under the plot: its axis' labels, which the app writes.
  await app.waitFor("99.58");
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

test("Tab reaches the drawdown, whose arrow keys move the day it reads out", async () => {
  // The first Right on the value plot starts at its first day.
  await tabTo("DAY 1");
  await app.keyboard.press("right");
  await app.waitFor("DAY 2");
  await app.keyboard.press("end");
  await app.waitFor("DAY 120");
  await app.keyboard.press("home");
  await app.waitFor("DAY 1");
  // Escape clears the hover: the readout is back on the last day, at a high.
  await app.keyboard.press("escape");
  await app.waitFor("at a high");
  expect(app.texts()).toContain("DAY 120");
}, 120000);

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

test("as a pie, the revenue's shares are written outside its ring", async () => {
  // The donut has none: its shares are in the legend, to a tenth.
  expect(app.texts()).not.toContain("39%");
  await app.press("Show as pie");
  await app.waitFor("Show as donut");
  // A label per slice, its share whole.
  for (const share of ["39%", "25%", "22%", "8%", "6%"]) {
    await app.waitFor(share);
  }
  await app.press("Show as donut");
  await app.waitFor("Show as pie");
  expect(app.texts()).not.toContain("39%");
});

test("the donut's slices step with the arrow keys once Tab reaches it", async () => {
  await tabTo("NORTH AMERICA");
  await app.keyboard.press("right");
  await app.waitFor("EMEA");
  await app.keyboard.press("end");
  await app.waitFor("OTHER");
  // Escape clears the hover: the total is back in the hole.
  await app.keyboard.press("escape");
  await app.waitFor("TOTAL");
}, 120000);

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

test("the radar reads out the factor nearest the pointer and changes its benchmark", async () => {
  // Nothing hovered: the means of all six, the portfolio's (362 / 6) a
  // figure of its own, and its spread over the index's (327 / 6 = 54.5).
  expect(app.texts()).toContain("ALL SIX FACTORS");
  expect(app.texts()).toContain("60.3");
  expect(app.texts()).toContain("+5.8");
  // Against the peers (371 / 6): the spread turns negative.
  await app.press("role:tab[vs Peers]");
  await app.waitFor("−1.5");
  // The middle of the radar: the factor whose spoke is nearest the pointer's
  // angle there (which one depends on where the pointer lands within a point
  // of it), its name read out.
  await app.hover("label:/^Factor exposure against the peers/");
  await app.waitFor("text:/^(VALUE|MOMENTUM|QUALITY|SIZE|LOW VOL|YIELD)$/");
});

test("a quarter's income flows from its segments to net income, and into the next quarter's", async () => {
  // The flows are one image, named with what they show; each account named beside its node (once they have drawn in), the margins under them.
  expect(app.count("role:image[Income flows, Q3: $85.5B revenue, $19.9B net income, a net margin of 23.3%]")).toBe(1);
  await app.clock!.runFor(1500);
  for (const name of ["Products", "Gross profit", "Net income"]) expect(app.texts()).toContain(name);
  expect(app.texts()).toContain("46.4%");
  // The next quarter's flows: the readout and the margins follow.
  await app.press("role:tab[Q4]");
  await app.waitFor("$93.3B");
  expect(app.count("role:image[Income flows, Q4: $93.3B revenue, $23.1B net income, a net margin of 24.8%]")).toBe(1);
});

test("the flows read out the account the arrow keys step to", async () => {
  // The first Right on the flows starts at their first account.
  await tabTo("PRODUCTS");
  expect(app.texts()).toContain("$61.6B");
  await app.keyboard.press("right");
  await app.waitFor("SERVICES");
  await app.keyboard.press("end");
  await app.waitFor("TAX");
  // Escape clears the hover: revenue is read out again.
  await app.keyboard.press("escape");
  await app.wait(100);
  expect(app.texts()).not.toContain("TAX");
}, 120000);

test("the watchlist's sparklines come with their rows and show each period", async () => {
  await app.waitFor("label:/^AAPL, 1D: /");
  // Down to the last symbols and back: the list makes their rows, each
  // with its sparkline, as they scroll in.
  await app.scroll("id:watchlist", 52 * 13);
  await app.waitFor("label:/^SHOP, 1D: /");
  await app.scroll("id:watchlist", -52 * 13);
  await app.waitFor("label:/^AAPL, 1D: /");
  await app.press("role:tab[1W]");
  await app.waitFor("label:/^AAPL, 1W: /");
  expect(app.count("label:/^AAPL, 1D: /")).toBe(0);
});
