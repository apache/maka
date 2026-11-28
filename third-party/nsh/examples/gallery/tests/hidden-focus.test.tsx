// Tab and the views a `display: none` view holds, mounted hidden or hidden
// after they showed: Tab passes by its links, controls and inputs, and a
// focused control that hides gives the focus up, so no key acts on it. A
// browser (`--target web`) lays each such view out at no size and would
// otherwise stop at it, as Windows (`--target windows`) would; headless,
// only shown views are stops.
import { expect, open, test } from "nsh/test";

test("Tab passes by what hidden views hold", async () => {
  const app = await open("./fixtures/hidden-focus.tsx", { platform: "macos", width: 400, height: 300 });
  await app.waitFor("Panel hidden");
  await app.keyboard.press("tab");
  await app.keyboard.press("enter");
  await app.waitFor("text:/pressed/");
  expect(app.texts()).toContain("Log: Shown focused, Shown pressed");
});

test("a focused control that hides gives up the focus", async () => {
  const app = await open("./fixtures/hidden-focus.tsx", { platform: "macos", width: 400, height: 300 });
  await app.waitFor("Panel hidden");
  // The web's and Windows': the headless driver keeps the key focus on a
  // view that hides (macOS gives it up too: #1832).
  if (!app.shows("Platform: web") && !app.shows("Platform: windows")) return;
  // The control, then the selected tab.
  await app.keyboard.press("tab");
  await app.keyboard.press("tab");
  await app.keyboard.press("x");
  await app.waitFor("Tabs hidden");
  // Right would select the next tab, Return and Space press the focused one.
  await app.keyboard.press("right");
  await app.keyboard.press("enter");
  await app.keyboard.press("space");
  await app.wait(300);
  expect(app.texts()).toContain("Log: Shown focused");
});

test("a focused field that hides gives up the focus", async () => {
  const app = await open("./fixtures/hidden-focus.tsx", { platform: "macos", width: 400, height: 300 });
  await app.waitFor("Panel hidden");
  // As above: headless, a hidden field keeps the focus.
  if (!app.shows("Platform: web") && !app.shows("Platform: windows")) return;
  await app.type("text:Away field", "ab");
  await app.keyboard.press("ctrl+h");
  await app.waitFor("Field hidden");
  // A key now reaches no field: "c" is typed nowhere.
  await app.keyboard.press("c");
  await app.wait(300);
  expect(app.texts()).toContain(
    "Log: Away field focused, Away field = a, Away field = ab, Away field blurred",
  );
});
