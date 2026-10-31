// The Stocks demo on a manual clock: the watchlist ticks every 50 ms, the
// strip opens breadth, the filters re-sort, a stock's screen follows the
// feed, the book shows ten levels, and the ticket places an order.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

/** The market clocks shown (`HH:MM:SS`). */
const clocks = (app: App) => app.texts().filter((t) => /^\d\d:\d\d:\d\d$/.test(t));

test("the watchlist ticks, filters and opens a stock that places an order", async () => {
  const app = await open(".", { clock: {} });
  await app.press("label:Stocks");
  for (const text of ["Composite", "All", "Gainers", "ORBX", "Orbex Freight", "FLKS"]) {
    expect(app.texts()).toContain(text);
  }
  // The clock moves a market second per tick.
  const before = clocks(app);
  expect(before).toHaveLength(1);
  await app.clock!.runFor(500);
  expect(clocks(app)).not.toEqual(before);

  // The strip opens breadth and the sectors.
  await app.press("Composite");
  await app.waitFor("Technology");
  expect(app.texts().some((t) => t.endsWith("issues"))).toBe(true);

  // Gainers only: the losers leave.
  await app.press("Gainers");
  await app.waitFor("ORBX", { state: "gone" });
  await app.press("All");
  await app.waitFor("ORBX");

  // A stock: its quote, chart, book, tape and flow, live.
  await app.press("ORBX");
  for (const text of [
    "Industrials",
    "Prev close",
    "Intraday",
    "Order book",
    "5 → 10",
    "A5",
    "B5",
    "Time & sales",
    "Depth",
    "Trade flow",
    "Ranges",
    "Sell",
    "Buy",
  ]) {
    await app.waitFor(text);
  }
  const quoted = clocks(app);
  await app.clock!.runFor(500);
  expect(clocks(app)).not.toEqual(quoted);

  // Ten levels, still ticking.
  await app.press("5 → 10");
  await app.waitFor("10 → 5");
  expect(app.texts()).toContain("A10");
  expect(app.texts()).toContain("B10");
  const deeper = clocks(app);
  await app.clock!.runFor(500);
  expect(clocks(app)).not.toEqual(deeper);

  // The ticket: review and place a sell order.
  await app.press("Sell");
  await app.waitFor("Sell ORBX");
  await app.press("Review sell");
  await app.waitFor("LIMIT · DAY");
  await app.press("Place sell order");
  await app.waitFor("Sell order placed");
});
