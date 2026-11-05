// The HoverCard demo: on a Mac a mention's card opens once the pointer
// rested on it, stays while the pointer is in the card (its Follow button
// works), and closes once the pointer left both; a ticker's quote ticks
// only while its card is open. On a phone a tap opens and closes a card,
// and the mention's link still reports its press.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1200, height: 1600, clock: {} } as const;

test("a mention's card opens after the delay and stays while the pointer is in it", async () => {
  const app = await open("../App.tsx", desktop);
  await app.press("role:button[HoverCard]");
  await app.waitFor("Mentions in a thread");
  await app.hover("id:mention-mira");
  await app.clock!.runFor(400);
  expect(app.shows("Design lead · Platform")).toBe(false);
  await app.clock!.runFor(300);
  await app.waitFor("Design lead · Platform");
  await app.waitFor("@mira opened · hover");
  // Into the card: it stays, and its button works.
  await app.hover("text:Design lead · Platform");
  await app.clock!.runFor(1000);
  expect(app.shows("Design lead · Platform")).toBe(true);
  await app.press("role:button[Follow]");
  await app.waitFor("followed Mira Chen");
  await app.waitFor("1,205");
  // Away from both: closed after 300 ms, gone after its 150 ms fade.
  await app.hover("text:Mentions in a thread");
  await app.clock!.runFor(200);
  expect(app.shows("Design lead · Platform")).toBe(true);
  await app.clock!.runFor(400);
  expect(app.shows("Design lead · Platform")).toBe(false);
  await app.waitFor("@mira closed · hover");
});

test("Escape closes a card at once", async () => {
  const app = await open("../App.tsx", desktop);
  await app.press("role:button[HoverCard]");
  await app.waitFor("Mentions in a thread");
  await app.hover("id:mention-ravi");
  await app.clock!.runFor(700);
  await app.waitFor("Staff engineer · Runtime");
  await app.keyboard.press("escape");
  await app.waitFor("@ravi closed · cancel");
});

test("a ticker's quote ticks only while its card is open", async () => {
  const app = await open("../App.tsx", desktop);
  await app.press("role:button[HoverCard]");
  await app.waitFor("A stock ticker");
  await app.hover("id:ticker-NVDA");
  await app.clock!.runFor(700);
  await app.waitFor("NVIDIA Corp.");
  await app.waitFor("$NVDA opened · hover");
  expect(app.shows("138.85")).toBe(true);
  // Two ticks: up 0.6 and down 0.3 of a mille.
  await app.clock!.runFor(1800);
  await app.waitFor("138.89");
  // Closed, it stops: open again, it shows where it stopped.
  await app.hover("text:A stock ticker");
  await app.clock!.runFor(2000);
  await app.waitFor("$NVDA closed · hover");
  await app.hover("id:ticker-NVDA");
  await app.clock!.runFor(700);
  await app.waitFor("138.89");
});

test("on a phone a tap opens and closes a card, and the link reports its press", async () => {
  const app = await open("../App.tsx", { clock: {} });
  // A tall phone: the events at the bottom in view.
  await app.setViewport(390, 3200);
  await app.press("role:button[HoverCard]");
  await app.waitFor("Mentions in a thread");
  await app.press("id:mention-mira");
  await app.waitFor("Design lead · Platform");
  await app.waitFor("@mira opened · triggerPress");
  expect(app.shows("onPress /people/mira")).toBe(true);
  await app.press("id:mention-mira");
  await app.waitFor("@mira closed · triggerPress");
  await app.clock!.runFor(300);
  expect(app.shows("Design lead · Platform")).toBe(false);
});
