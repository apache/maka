// The index of the Rust gallery: its groups, and every demo it opens.
import { expect, open, test } from "nsh/test";

test("the index groups the demos and counts them", async () => {
  const app = await open(".");
  const texts = app.texts();
  // Each group's count follows its title.
  for (const [title, count] of [
    ["APPS", "3"],
    ["LAYOUT AND LISTS", "4"],
    ["TOUCH AND MOTION", "4"],
    ["DRAWING AND TYPE", "5"],
    ["PLATFORM", "5"],
  ]) {
    expect(texts[texts.indexOf(title) + 1]).toBe(count);
  }
});

test("every demo opens from the index and goes back to it", async () => {
  const app = await open(".", { clock: {} });
  // A demo's row, and a text only its screen shows.
  for (const [name, shown] of [
    ["Stocks", "Composite"],
    ["AI Chat", "How can I help?"],
    ["Photos", "1,000 photos"],
    ["Lists", "90 items, 3 columns"],
    ["Scrolling", "pagingEnabled · scrollValue"],
    ["Navigation", "Native stack"],
    ["Form", "Create the account"],
    ["File drops", "Drop files or directories from your file manager"],
    ["Gestures", "Press events"],
    ["Physics", "Drag and release"],
    ["Animations", "Native motion"],
    ["Canvas", "Turbine 3 load"],
    ["Styles", "Per-side borders"],
    ["Typed styles", "Resolved natively"],
    ["Text", "Spans and links"],
    ["Images", "Resize modes"],
    ["Components", "Press feedback"],
    ["WebView", "Inline HTML, with messages both ways"],
    ["Video", "AVPlayer / MediaPlayer"],
    ["System", "Safe area insets"],
    ["Storage", "Stored keys"],
  ]) {
    await app.press(`label:${name}`);
    await app.waitFor(shown);
    // The demo's screen covers the index.
    expect(app.shows("APPS")).toBe(false);
    await app.back();
    await app.waitFor("APPS");
  }
});
