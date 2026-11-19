// `keymap.bind(..., { forFocus: true })`: the keys of the view that has the
// focus. A plain Return or Space presses a focused control before the app's
// bindings, so a tile's own Space needs `forFocus` to reach it. Headless, and
// on macOS (`nsh test --target macos`).
import { expect, open, test } from "nsh/test";

const desktop = { width: 600, height: 400, platform: "macos" } as const;

test("a focused tile's forFocus Space flips it, its Return still opens it", async () => {
  const app = await open("./fixtures/keymap-for-focus.tsx", desktop);
  await app.keyboard.press("tab");
  await app.keyboard.press("space");
  await app.waitFor("text:A on");
  expect(app.shows("text:Opened [] Page 0")).toBe(true);
  await app.keyboard.press("enter");
  await app.waitFor("text:Opened [A] Page 0");
  // The next tile's: the first tile's binding left with its focus.
  await app.keyboard.press("tab");
  await app.keyboard.press("space");
  await app.waitFor("text:B on");
  expect(app.shows("text:A on")).toBe(true);
  expect(app.shows("text:Opened [A] Page 0")).toBe(true);
});
