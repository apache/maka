// The Lists demo: its tabs switch, the grid reports the rows it shows,
// the sections list its contacts, the chat sends and loads older messages
// at its end, the empty list fills and clears.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open(".", { clock: {} });
  await app.press("label:Lists");
});

test("the grid shows its rows and the ones in view", async () => {
  for (const text of [
    "Grid",
    "Sections",
    "Chat",
    "More",
    "Viewable items (at least half shown)",
    "90 items, 3 columns",
    "Jump to 60",
    "End",
    "0",
    "84 pt",
    "1",
    "106 pt",
    "End of the list",
  ]) {
    expect(app.texts()).toContain(text);
  }
  // The rows at least half shown.
  expect(app.texts()).toContain("0–8  9 visible");
  await app.press("Jump to 60");
  await app.waitFor("60");
  expect(app.texts().some((t) => t.startsWith("0–"))).toBe(false);
});

test("the sections list their contacts", async () => {
  await app.press("Sections");
  for (const text of ["A", "2", "AL", "Ada Lovelace", "Analytical Engine notes", "AK", "B", "Barbara Liskov"]) {
    await app.waitFor(text);
  }
  expect(app.shows("Jump to 60")).toBe(false);
});

test("the chat sends a message and loads older ones at its end", async () => {
  await app.press("Chat");
  for (const text of ["Release room", "30 messages, 0 older pages", "Did the build go out?", "09:00"]) {
    await app.waitFor(text);
  }
  await app.type("text:Message", "Hello there");
  await app.submit("text:Hello there");
  await app.waitFor("Hello there");
  await app.waitFor("31 messages, 0 older pages");
  // Scrolled up to its end (the oldest messages, at the top of the
  // inverted list), older ones load.
  await app.scroll("Did the build go out?", -3000);
  await app.waitFor("text:/^Older message/");
  expect(app.texts().some((t) => /^\d+ messages, [12] older pages$/.test(t))).toBe(true);
});

test("the empty list fills and clears", async () => {
  await app.press("More");
  for (const text of [
    "Pull to refresh",
    "Pull the page down",
    "refreshes",
    "Horizontal scroll view",
    "This week",
    "Today",
    "Horizontal list",
    "1,000 recycled cards",
    "Card 1",
    "0 %",
    "An empty list",
    "0 items",
    "Nothing here yet: tap Add",
  ]) {
    await app.waitFor(text);
  }
  // A range chip selects itself: the note follows.
  await app.press("Yesterday");
  expect(app.count("text:Yesterday")).toBe(2);
  await app.press("Add");
  await app.press("Add");
  await app.waitFor("2 items");
  for (const text of ["accent", "info", "Item 1", "Item 2"]) {
    expect(app.texts()).toContain(text);
  }
  expect(app.shows("Nothing here yet: tap Add")).toBe(false);
  await app.press("Clear");
  await app.waitFor("0 items");
  expect(app.texts()).toContain("Nothing here yet: tap Add");
});
