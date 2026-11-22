// UIKit regression: run this directory with `nsh test --target ios`. In a
// stack that starts below the status bar, a page below its header keeps its
// place when the page pushed over it, which hid the header, is popped: the
// bar comes back with the pop, and the page rests below where the bar ends.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

/** The height page `name` gives its content once it settled. */
async function height(app: App, name: string): Promise<number> {
  await app.waitFor(`text:/^${name} height:\\d/`);
  await app.wait(700);
  const line = app.texts().find((t) => t.startsWith(`${name} height:`)) ?? "";
  return Number(line.match(/height:(\d+)/)?.[1]);
}

/** Pushes a page with `press` over the root page, pops it and answers the
 * height the root page's content has then. */
async function afterPop(app: App, press: string, pushed: string): Promise<number> {
  await app.press(`text:${press}`);
  await height(app, pushed);
  await app.press("text:Pop");
  await app.waitFor(`text:/^${pushed} height:/`, { state: "gone" });
  return height(app, "Root");
}

test("a page keeps its place below the header after a page that hid the header is popped", async () => {
  const app = await open("./App.tsx");
  const before = await height(app, "Root");
  expect(await afterPop(app, "Push hidden", "Hidden")).toBe(before);
});

test("a page keeps its place below the header after a page with a header is popped", async () => {
  const app = await open("./App.tsx");
  const before = await height(app, "Root");
  expect(await afterPop(app, "Push visible", "Visible")).toBe(before);
});
