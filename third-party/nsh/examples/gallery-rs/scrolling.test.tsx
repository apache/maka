// The Scrolling demo: its sections, a drag on the events' box is logged
// with its offsets, prepending posts keeps them counted, the keyboard
// taps choice and its button.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open(".", { clock: {} });
  await app.press("label:Scrolling");
});

test("shows its sections", () => {
  for (const text of [
    "Paging",
    "5 pages",
    "pagingEnabled · scrollValue",
    "Revenue · 1 of 5",
    "48.2k +12 %",
    "Errors · 5 of 5",
    "Settled on page 1",
    "Snapping",
    "snapToInterval · snapToAlignment",
    "Card 1",
    "at 0 pt",
    "center",
    "One card per fling",
    "disableIntervalMomentum",
    "Zoom",
    "maximumZoomScale · zoomTo()",
    "1.00 × fit",
    "0.5× to 5×",
    "Tile 1",
    "Events and behavior",
    "0 pt Scroll the box",
    "viewport — pt",
    "No drags yet",
    "Scroll events at most every",
    "Scroll enabled",
    "scrollable",
    "Bounces",
    "Content inset",
    "40 pt at the top and bottom",
    "Bounces past the limits",
    "Prepending keeps the position",
    "Post 1",
    "#0",
    "30 posts",
    "Taps with the keyboard up",
    "Tap me",
    "A tap outside the input only hides the keyboard; the button does not get it.",
  ]) {
    expect(app.texts()).toContain(text);
  }
});

test("a drag on the box is logged with its offsets", async () => {
  // The box: the scroll view of its 30 numbered rows.
  await app.scroll("text:30", 40);
  await app.waitFor("begin drag");
  expect(app.shows("No drags yet")).toBe(false);
  // The drag's ends, where they were.
  expect(app.texts()).toContain("end drag");
  expect(app.texts()).toContain("at 40 pt");
  // The offset as the (throttled) scroll events report it, of the
  // content's height.
  expect(app.shows("0 pt Scroll the box")).toBe(false);
  await app.waitFor("text:/^\\d+ pt \\/ \\d+$/");
});

test("prepending posts adds them on top", async () => {
  await app.press("Add 3 posts on top");
  await app.waitFor("New 1");
  expect(app.texts()).toContain("new");
  expect(app.texts()).toContain("33 posts");
});

test("the keyboard taps choice and its button", async () => {
  await app.press("handled");
  await app.waitFor("The button gets the tap and the keyboard stays; a tap on empty space hides it.");
  await app.press("Tap me");
  const texts = app.texts();
  expect(texts[texts.indexOf("Tap me") + 1]).toBe("1");
});
