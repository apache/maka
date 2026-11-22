// The Charts demo: charts an app builds from `nsh/base/plot`'s parts and
// its own views. A live price streamed a tick a second that pauses and
// resumes, its window's high written over it and its last price tagged, an order book's depth whose side under the pointer is read out
// and whose range changes, a drawdown whose day under the pointer or the
// arrow keys is read out over both of its plots, capacity rings by period,
// a donut of revenue that reports the slice under the pointer (none in its
// hole) or the arrow keys and closes into a pie with its shares written
// outside, sales as bars side by side or stacked, a quarter's profit
// bridge whose steps the arrow keys read out and whose quarters move into
// each other, a conversion funnel that reads out the stage under the
// pointer and changes its channel, daily candles over their volume whose
// day under the pointer is read out from either plot and whose period
// changes, a portfolio's holdings as bubbles of risk against return
// whose holding under the pointer or the arrow keys is read out and whose
// period moves them, analysts' price targets as a dot plot whose stock the
// arrow keys read out and whose list changes, volume and price on two y
// scales aligned in the same steps whose row under the pointer reads out
// both and whose period changes, revenue and margin whose scales put zero
// on one line for a segment that loses money and move to another segment,
// heatmaps: a correlation matrix whose pair under the pointer or the arrow
// keys is read out and whose lookback changes, a calendar of monthly
// returns whose month under the pointer is read out and whose symbol
// changes, and a week of trades per half hour whose cells the arrow keys
// step across and whose market changes, a radar of factor
// exposure that reads out the factor nearest the pointer and changes its
// benchmark, a quarter's income as flows between its accounts, read out
// under the arrow keys and moving into the next quarter's, a market map
// of stocks by sector that reads out the stock or sector under the pointer
// or the arrow keys and recolors with the period, a portfolio's allocation
// by asset class that moves to a year ago, and a
// watchlist whose sparklines come with their rows as its list scrolls and
// show each period.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
/** The Charts page with a mouse to hover with and a manual clock for the stream's ticks. */
const start = async (reducedMotion = false) => {
  app = await open("../App.tsx", { platform: "macos", width: 1200, height: 1700, clock: {}, reducedMotion });
  await app.press("role:button[Plot]");
  await app.waitFor("Live price");
  // The page makes its charts as they scroll near: down until the last one
  // (the watchlist) is made, then back to the top, so every test finds its
  // chart. The page's first screen is made with it.
  expect(app.shows("id:watchlist")).toBe(false);
  let pages = 0;
  while (!app.shows("id:watchlist")) {
    expect(++pages).toBeLessThan(12);
    await app.scroll("Live price", 1200);
  }
  await app.scroll("Live price", -1200 * pages);
};
/**
 * A test of the Charts page as `start` opens it. The keyboard's tests open
 * it themselves, with reduced motion (`tabTo`), so it is not opened twice.
 * Opening it has its own 30 s, as a `beforeEach` would.
 */
const pageTest = (name: string, body: () => Promise<void>, timeout = 30_000) =>
  test(
    name,
    async () => {
      await start();
      await body();
    },
    timeout + 30_000,
  );

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
    expect(++tabs).toBeLessThan(60);
    await app.keyboard.press("tab");
    await app.keyboard.press("right");
    await app.wait(50);
  }
};

pageTest("each chart is one image for screen readers", async () => {
  expect(app.count("role:image")).toBeGreaterThan(6);
});

pageTest("the live price ticks every second until it is paused", async () => {
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

pageTest("the live price writes its window's high over it and tags its last price", async () => {
  const after = (label: string) => {
    const texts = app.texts();
    return texts[texts.indexOf(label) + 1];
  };
  // Over the line, the high the figures under it read; at the line's end,
  // the price the card's figure reads.
  expect(app.texts()).toContain(`High ${after("HIGH")}`);
  const last = price();
  expect(app.texts().filter((t) => t === last).length).toBeGreaterThanOrEqual(2);
  await app.clock!.runFor(3000);
  expect(app.texts()).toContain(`High ${after("HIGH")}`);
  const now = price();
  expect(app.texts().filter((t) => t === now).length).toBeGreaterThanOrEqual(2);
});

pageTest("the depth reads out the side under the pointer and changes its range", async () => {
  // The ends' prices under the plot: its axis' labels, which the app writes.
  await app.waitFor("99.58");
  await app.hover("label:/^Order book depth within 20 ticks/");
  await app.wait(100);
  expect(app.texts().some((t) => t.startsWith("BIDS ≥") || t.startsWith("ASKS ≤"))).toBe(true);
  await app.press("role:tab[40 ticks]");
  await app.waitFor("99.18");
});

pageTest("the drawdown reads out the day under the pointer on either plot", async () => {
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

pageTest("the capacity rings show each period's load", async () => {
  expect(app.texts()).toContain("49%");
  await app.press("role:tab[7d peak]");
  await app.waitFor("88%");
  expect(app.texts()).toContain("92%");
});

pageTest("a donut reports the slice under the pointer, none in its hole", async () => {
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

pageTest("as a pie, the revenue's shares are written outside its ring", async () => {
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

pageTest("bars stand in bands side by side or stacked, a value over each", async () => {
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

pageTest("the profit bridge writes each step's change at its end and moves into another quarter", async () => {
  // 4Q26: revenue down to net profit, the totals' levels and the other steps' signed changes on the bars.
  expect(app.count("role:image[Profit bridge, 4Q26: $142.7M revenue to $33.1M net profit, a net margin of 23.2%]")).toBe(1);
  expect(app.texts()).toContain("NET PROFIT");
  expect(app.texts()).toContain("23.2% net margin");
  for (const label of ["142.7", "−54.1", "88.6", "+3.9", "33.1"]) expect(app.texts()).toContain(label);
  for (const short of ["Rev", "COGS", "Gross", "SG&A", "Net"]) expect(app.texts()).toContain(short);
  // 3Q26: other income turns into a loss, the margins follow.
  await app.press("role:tab[3Q26]");
  await app.waitFor("17.1% net margin");
  expect(app.texts()).toContain("−1.4");
  expect(app.texts()).toContain("$22.4M");
  expect(app.count("role:image[Profit bridge, 3Q26: $131.2M revenue to $22.4M net profit, a net margin of 17.1%]")).toBe(1);
});

test("the profit bridge reads out the step the arrow keys move to", async () => {
  // The first Right on the bridge starts at revenue, all of itself.
  await tabTo("100.0% of revenue");
  expect(app.texts()).toContain("REVENUE");
  await app.keyboard.press("right");
  await app.waitFor("COST OF SALES");
  expect(app.texts()).toContain("−$54.1M");
  expect(app.texts()).toContain("37.9% of revenue");
  await app.keyboard.press("end");
  await app.waitFor("23.2% of revenue");
  // Escape clears the hover: net profit and its margin again.
  await app.keyboard.press("escape");
  await app.waitFor("23.2% net margin");
}, 120000);

pageTest("the funnel reads out the stage under the pointer and changes its channel", async () => {
  // Every channel's visits to first trades: each stage's name over its
  // count, what it keeps of the stage before, what is lost in each gap.
  expect(app.texts()).toContain("VISITS TO FIRST TRADE");
  expect(app.texts()).toContain("10,240 traders of 184,200 visits");
  for (const label of ["184,200", "10,240", "23.0%", "67.1%", "52.9%", "68.2%", "−77.0%", "−32.9%", "−47.1%", "−31.8%"]) expect(app.texts()).toContain(label);
  for (const name of ["Visits", "KYC verified", "First trade"]) expect(app.texts()).toContain(name);
  // The biggest drop, under the bars: into sign-ups.
  expect(app.texts()).toContain("BIGGEST DROP");
  expect(app.texts()).toContain("Sign-ups");
  // The pointer at the middle: the third of five stages.
  await app.hover("label:/^Conversion funnel, All: /");
  await app.waitFor("KYC VERIFIED");
  expect(app.texts()).toContain("28,410");
  expect(app.texts()).toContain("67.1% of sign-ups · 15.4% of visits");
  // The web's stages, on the same scale.
  await app.press("role:tab[Web]");
  await app.waitFor("87,400");
  expect(app.texts()).toContain("17.4%");
  expect(app.texts()).toContain("−82.6%");
  expect(app.count("label:/^Conversion funnel, Web: 87,400 visits to 2,410 first trades, 2.8%/")).toBe(1);
});

pageTest("the candles read out the day under the pointer on either plot and change their period", async () => {
  // Two months of days, the last one read out: its date, close and range.
  expect(app.count("label:/^NSHL daily candles, 2M: 177.59 to 196.62, /")).toBe(1);
  expect(app.texts()).toContain("OCT 30");
  expect(app.texts()).toContain("196.62");
  expect(app.texts()).toContain("23 / 41");
  // The middle of the volume: the 21st of 41 days, its close and volume read out.
  await app.hover("label:/^NSHL volume, 2M/");
  await app.waitFor("OCT 2");
  expect(app.texts()).toContain("181.20");
  expect(app.texts().some((t) => t.includes("13.8M"))).toBe(true);
  // Three months: from August, its candles drawn in again.
  await app.press("role:tab[3M]");
  await app.waitFor("label:/^NSHL daily candles, 3M: 167.50 to 196.62, /");
  expect(app.texts()).toContain("36 / 61");
  // The middle of the candles once they have drawn in (800 ms): the 31st of 61 days.
  await app.wait(1000);
  await app.hover("label:/^NSHL daily candles, 3M/");
  await app.waitFor("SEP 18");
  expect(app.texts()).toContain("177.87");
});

pageTest("the risk-return bubbles read out the holding under the pointer and move with the period", async () => {
  // Nothing hovered: the holdings' means over three years, the best Sharpe
  // ratio and how many beat the index's under the plot.
  expect(app.count("label:/^Risk and return of 17 holdings, 3Y: best Sharpe LLY, 3 ahead of the S&P 500/")).toBe(1);
  let texts = app.texts();
  expect(texts).toContain("PORTFOLIO · 3Y");
  expect(texts).toContain("+12.1%");
  expect(texts).toContain("LLY 1.23");
  expect(texts).toContain("3 / 17");
  // The middle of the plot once the bubbles have grown in (1000 ms): Amazon over three years.
  await app.wait(1200);
  await app.hover("label:/^Risk and return of 17 holdings, 3Y/");
  await app.waitFor("AMZN · AMAZON");
  texts = app.texts();
  expect(texts).toContain("+11.0%");
  expect(texts).toContain("34.0% vol · Sharpe 0.21");
  expect(texts).toContain("Consumer · $2.4T market cap");
  // A year: every holding's numbers change, the best Sharpe with them.
  await app.press("role:tab[1Y]");
  await app.waitFor("label:/^Risk and return of 17 holdings, 1Y: best Sharpe GS, 2 ahead of the S&P 500/");
  expect(app.texts()).toContain("GS 1.31");
  // Back over the middle of the plot once the bubbles have moved (pressing
  // the period took the pointer off the plot in a real window): Eli Lilly
  // is there over a year, read out with its numbers.
  await app.wait(1200);
  await app.hover("label:/^Risk and return of 17 holdings, 1Y/");
  await app.waitFor("LLY · ELI LILLY");
  texts = app.texts();
  expect(texts).toContain("+12.0%");
  expect(texts).toContain("33.0% vol · Sharpe 0.24");
  expect(texts).toContain("Healthcare · $820B market cap");
});

test("the risk-return bubbles step with the arrow keys from the least volatile", async () => {
  // The first Right starts at the left end: the rows are in the order of their volatility.
  await tabTo("JNJ · JOHNSON & JOHNSON");
  expect(app.texts()).toContain("Healthcare · $460B market cap");
  // The index is a row of its own, read out as the benchmark.
  await app.keyboard.press("right");
  await app.waitFor("S&P 500 · BENCHMARK");
  expect(app.texts()).toContain("The index the holdings are measured against");
  await app.keyboard.press("end");
  await app.waitFor("NVDA · NVIDIA");
  expect(app.texts()).toContain("+44.0%");
  await app.keyboard.press("escape");
  await app.waitFor("PORTFOLIO · 3Y");
}, 120000);

test("the price targets read out the stock the arrow keys step to and change their list", async () => {
  // The first Right starts at the top row: the most upside.
  await tabTo("NVDA · 64 ANALYSTS");
  let texts = app.texts();
  expect(texts).toContain("$228");
  expect(texts).toContain("+22.6% from $186");
  expect(texts).toContain("$140 – $300 · revised +8.6% in 3 months");
  await app.keyboard.press("right");
  await app.waitFor("AVGO · 41 ANALYSTS");
  await app.keyboard.press("end");
  await app.waitFor("INTC · 38 ANALYSTS");
  expect(app.texts()).toContain("−5.3% from $38.00");
  await app.keyboard.press("escape");
  await app.waitFor("SEMIS · 6 STOCKS");
  texts = app.texts();
  expect(texts).toContain("5 of 6 raised in the last 3 months");
  // The banks: their stocks and their median upside.
  await app.press("role:tab[Banks]");
  await app.waitFor("BANKS · 6 STOCKS");
  texts = app.texts();
  expect(texts).toContain("+9.0%");
  expect(texts).toContain("C +14%");
  expect(app.count("label:/^Analysts' price targets, Banks: a median upside of \\+9\\.0%, the most for C at \\+14\\.3%/")).toBe(1);
}, 120000);

pageTest("volume and price read out both values on scales aligned in the same steps, and change their period", async () => {
  // Six months by week, the last one read out; neither scale names a
  // domain, so both take the same steps: four ticks on each side.
  expect(app.count("label:/^ORBX volume and close, 6M: \\+30\\.3%/")).toBe(1);
  let texts = app.texts();
  for (const t of ["WEEK TO OCT 30", "$214.08", "Volume 244M", "0", "100M", "200M", "300M", "160", "180", "200", "220"]) expect(texts).toContain(t);
  // The middle of the weeks once they have drawn in: its close and volume.
  await app.wait(1000);
  await app.hover("label:/^ORBX volume and close/");
  await app.waitFor("WEEK TO JUL 31");
  texts = app.texts();
  expect(texts).toContain("Volume 243M");
  expect(texts).toContain("Close $188.44");
  // Two years by month: both scales move to their new steps.
  await app.press("role:tab[2Y]");
  await app.waitFor("label:/^ORBX volume and close, 2Y: \\+87\\.9%/");
  texts = app.texts();
  for (const t of ["500M", "1B", "1.5B", "100", "150", "250", "AVG / MONTH"]) expect(texts).toContain(t);
});

pageTest("revenue and margin put zero on one line for a segment that loses money, and move to another segment", async () => {
  // Devices: losses below zero on the right scale, zero on the same grid
  // line on the left one, which writes no value under it.
  let texts = app.texts();
  for (const t of ["$0", "$6B", "−10%", "0%", "15%", "5 / 8"]) expect(texts).toContain(t);
  expect(texts).not.toContain("$−2B");
  expect(texts).not.toContain("$0B");
  // The quarter under the pointer once the bars have grown in.
  await app.wait(1000);
  await app.hover("label:/^Devices revenue and net margin/");
  await app.waitFor("Revenue $4.6B");
  expect(app.texts()).toContain("Net margin +5.8%");
  // Cloud: both scales move to the segment's values.
  await app.press("role:tab[Cloud]");
  await app.waitFor("$10B");
  texts = app.texts();
  for (const t of ["18%", "28%", "0 / 8", "+27.1%"]) expect(texts).toContain(t);
});

pageTest("the correlation matrix reads out the pair under the pointer and glides to another lookback", async () => {
  // Nothing hovered: the mean of the 28 pairs over a year, the closest
  // pair and the best hedge under the matrix.
  expect(app.count("label:/^Correlation of 8 holdings over 1Y: closest NVDA and AMD at 0\\.83, best hedge MSFT and GLD at −0\\.18/")).toBe(1);
  let texts = app.texts();
  expect(texts).toContain("8 HOLDINGS · 1Y");
  expect(texts).toContain("0.24");
  expect(texts).toContain("NVDA·AMD 0.83");
  expect(texts).toContain("MSFT·GLD −0.18");
  // Each coefficient written in its cell, both sides of the diagonal.
  expect(app.count("label:/^Correlation of 8 holdings/ >> text:0.83")).toBe(2);
  expect(app.count("label:/^Correlation of 8 holdings/ >> text:1.00")).toBe(8);
  // NVDA's line, AMD's column, once the cells have grown in (900 ms).
  await app.wait(1200);
  await app.hover("label:/^Correlation of 8 holdings/ >> text:0.83 >> nth=0");
  await app.waitFor("NVDA × AMD");
  expect(app.texts()).toContain("Move together closely");
  // Three years: the closest pair and the best hedge change; the pair read
  // out with its new coefficient (hovered again: on a real platform the
  // press moved the pointer away).
  await app.press("role:tab[3 years]");
  await app.waitFor("label:/^Correlation of 8 holdings over 3Y: closest NVDA and AMD at 0\\.76, best hedge JPM and GLD at −0\\.01/");
  await app.hover("label:/^Correlation of 8 holdings/ >> text:0.76 >> nth=0");
  await app.waitFor("NVDA × AMD");
  texts = app.texts();
  expect(texts).toContain("NVDA × AMD");
  expect(texts).toContain("0.76");
  expect(texts).toContain("Daily returns over three years");
  // Gold against JPMorgan: barely related over three years.
  await app.hover("label:/^Correlation of 8 holdings/ >> text:−0.01 >> nth=0");
  await app.waitFor("JPM × GLD");
  expect(app.texts()).toContain("Barely related");
}, 120000);

test("the correlation matrix's arrow keys step across its grid", async () => {
  // The first Right starts at the top left cell: NVDA against itself.
  await tabTo("NVDA × NVDA");
  expect(app.texts()).toContain("A holding against itself");
  // Right along NVDA's line, Down AMD's column, End to the line's last cell.
  await app.keyboard.press("right");
  await app.waitFor("NVDA × AMD");
  await app.keyboard.press("down");
  await app.waitFor("AMD × AMD");
  await app.keyboard.press("end");
  await app.waitFor("AMD × GLD");
  expect(app.texts()).toContain("−0.16");
  await app.keyboard.press("escape");
  await app.waitFor("8 HOLDINGS · 1Y");
}, 120000);

pageTest("the monthly returns read out the month under the pointer and change their symbol", async () => {
  // Nothing hovered: the S&P 500's months compounded, its best and worst
  // months and how many were up; each year's return beside its line, the
  // ramp's ends the largest move either way.
  expect(app.count("label:/^S&P 500 monthly returns since 2020: best Apr 2020 at \\+12\\.7%, worst Mar 2020 at −12\\.5%/")).toBe(1);
  let texts = app.texts();
  expect(texts).toContain("S&P 500 · 2020–2026");
  expect(texts).toContain("+141.3%");
  expect(texts).toContain("Apr 2020 +12.7%");
  expect(texts).toContain("Mar 2020 −12.5%");
  expect(texts).toContain("53 / 82");
  expect(texts).toContain("+36.2%");
  expect(texts).toContain("−16.1%");
  expect(texts).toContain("−12.7%");
  expect(texts).toContain("+12.7%");
  // The months along the top, the years down the left: the bands' categories.
  for (const label of ["Jan", "Jun", "Dec", "2020", "2026"]) expect(texts).toContain(label);
  // November 2023, once the cells have grown in (1000 ms).
  await app.wait(1200);
  await app.hover("label:/^S&P 500 monthly returns/ >> text:8.9");
  await app.waitFor("NOV 2023");
  texts = app.texts();
  expect(texts).toContain("+8.9%");
  expect(texts).toContain("S&P 500 · 2023 +27.2%");
  // NVIDIA: its years and its ramp's ends; then its best month under the
  // pointer (hovered again: on a real platform the press moved it away).
  await app.press("role:tab[NVDA]");
  await app.waitFor("label:/^NVDA monthly returns since 2020: best May 2023 at \\+36\\.3%, worst Sep 2022 at −19\\.6%/");
  texts = app.texts();
  expect(texts).toContain("+156.5%");
  expect(texts).toContain("+36.3%");
  // May 2023.
  await app.hover("label:/^NVDA monthly returns/ >> text:36");
  await app.waitFor("MAY 2023");
  expect(app.texts()).toContain("NVDA · 2023 +148.0%");
}, 120000);

test("the trading activity's arrow keys step across the week and its market changes", async () => {
  // The first Right starts at Monday's open.
  await tabTo("MON 9:30–10:00");
  expect(app.texts()).toContain("45.2k");
  await app.keyboard.press("down");
  await app.waitFor("TUE 9:30–10:00");
  expect(app.texts()).toContain("42.8k");
  await app.keyboard.press("end");
  await app.waitFor("TUE 15:30–16:00");
  expect(app.texts()).toContain("51.9k");
  await app.keyboard.press("escape");
  await app.waitFor("US · TRADES PER HALF HOUR");
  let texts = app.texts();
  expect(texts).toContain("361.9k");
  expect(texts).toContain("Fri 9:30");
  expect(texts).toContain("Mon 13:00");
  expect(texts).toContain("2.3×");
  // Hong Kong: fewer trades and a lunch break.
  await app.press("role:tab[HK]");
  await app.waitFor("HK · TRADES PER HALF HOUR");
  texts = app.texts();
  expect(texts).toContain("146.9k");
  expect(texts).toContain("Thu 14:00");
  expect(texts).toContain("2.1×");
  expect(texts).toContain("9:30 to 16:00, closed 12:00 to 13:00 for lunch");
  expect(app.count("label:/^Trades per half hour in HK: busiest Fri at 9:30 with 23\\.7k, quietest Thu at 14:00/")).toBe(1);
}, 120000);

pageTest("the radar reads out the factor nearest the pointer and changes its benchmark", async () => {
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
}, 120000);

pageTest("the radar reads out the factor nearest the pointer and changes its benchmark", async () => {
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
}, 120000);

pageTest("a quarter's income flows from its segments to net income, and into the next quarter's", async () => {
  // The flows are one image, named with what they show; each account named beside its node (once they have drawn in), the margins under them.
  expect(app.count("role:image[Income flows, Q3: $85.5B revenue, $19.9B net income, a net margin of 23.3%]")).toBe(1);
  await app.clock!.runFor(1500);
  // In this window's two columns of cards its columns are close: names of two words break over two lines.
  for (const name of ["Products", "Gross\nprofit", "Net\nincome"]) expect(app.texts()).toContain(name);
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

pageTest("the market map reads out the stock or sector under the pointer and recolors with the period", async () => {
  // Nothing hovered: the cap-weighted change of the day and how many rose.
  expect(app.count("label:/^Market map of 32 stocks in 6 sectors, 1D: 15 up/")).toBe(1);
  let texts = app.texts();
  expect(texts).toContain("S&P 500 · TOP 32 · 1D");
  expect(texts).toContain("+0.29%");
  // Each stock's ticker and change on its tile, each sector's name over its stocks.
  expect(texts).toContain("NVDA");
  expect(texts).toContain("+2.41%");
  expect(texts).toContain("Healthcare");
  // The middle of the map once the tiles have grown in: Broadcom.
  await app.wait(1200);
  await app.hover("label:/^Market map of 32 stocks/");
  await app.waitFor("AVGO · BROADCOM");
  expect(app.texts()).toContain("Technology · $1.6T market cap");
  // A month: the tiles' changes and the count of risers follow.
  await app.press("role:tab[Month]");
  await app.waitFor("label:/^Market map of 32 stocks in 6 sectors, 1M: 20 up/");
  texts = app.texts();
  expect(texts).toContain("+14.80%");
  expect(texts).toContain("+12%");
});

test("the market map steps across its stocks with the arrow keys", async () => {
  // The first Right starts at the largest stock, at the top left.
  await tabTo("NVDA · NVIDIA");
  expect(app.texts()).toContain("Technology · $4.4T market cap");
  await app.keyboard.press("down");
  await app.waitFor("MSFT · MICROSOFT");
  await app.keyboard.press("escape");
  await app.waitFor("S&P 500 · TOP 32 · 1D");
}, 120000);

pageTest("the allocation names its asset classes over their positions and moves to a year ago", async () => {
  expect(app.count("label:/^Allocation of \\$620k across 4 asset classes/")).toBe(1);
  let texts = app.texts();
  // The classes' weights over the map, their names in their bands, the positions' weights on them.
  expect(texts).toContain("60.8%");
  expect(texts).toContain("Equities");
  expect(texts).toContain("VOO");
  expect(texts).toContain("29.4%");
  expect(texts).toContain("TLT");
  expect(texts).not.toContain("ARKK");
  // A year ago: Treasuries not yet bought, the innovation fund still held.
  await app.press("role:tab[A year ago]");
  await app.waitFor("label:/^Allocation of \\$514k/");
  await app.wait(800);
  texts = app.texts();
  expect(texts).toContain("55.8%");
  expect(texts).toContain("13.6%");
  expect(texts).toContain("ARKK");
  expect(texts).not.toContain("TLT");
});

pageTest("the watchlist's sparklines come with their rows and show each period", async () => {
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
