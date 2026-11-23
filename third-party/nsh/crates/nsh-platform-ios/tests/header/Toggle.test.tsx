// UIKit regression: run this directory with `nsh test --target ios`. A page
// already on top of its stack that turns its header off or on takes the
// navigation bar with it: no transition shows or hides the bar, and the
// core lays the page out for the header it asked for, so a bar left on
// screen would cover the top of its content, and one left hidden would
// leave the page without its header.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

interface Rest {
  /** The page's top inset: what UIKit draws over the top of its content
   * (none below a header, the status bar without one). */
  top: number;
  /** The height its content got. */
  height: number;
}

/** Where page `name` rests once it settled. */
async function rest(app: App, name: string): Promise<Rest> {
  await app.waitFor(`text:/^${name} top:\\d+ height:\\d/`);
  await app.wait(700);
  const line = app.texts().find((t) => t.startsWith(`${name} top:`)) ?? "";
  const [, top, height] = line.match(/top:(\d+) height:(\d+)/) ?? [];
  return { top: Number(top), height: Number(height) };
}

test("a page on top that hides its header hides the bar", async () => {
  const app = await open("./Toggle.tsx");
  await rest(app, "Root");
  // Where a page pushed without a header rests: UIKit hid the bar for it.
  await app.press("text:Push hidden");
  const hidden = await rest(app, "Hidden");
  await app.press("text:Pop");
  await app.waitFor("text:/^Hidden top:/", { state: "gone" });
  await app.press("text:Toggle");
  expect(await rest(app, "Root")).toEqual(hidden);
});

test("a page on top that shows its header shows the bar", async () => {
  const app = await open("./Toggle.tsx");
  await rest(app, "Root");
  await app.press("text:Push hidden");
  await rest(app, "Hidden");
  await app.press("text:Toggle");
  await rest(app, "Hidden");
  // The core lays the page out for its header either way: the bar itself
  // has to be on screen, with the page's button in it.
  await app.press("label:Header add");
  await app.waitFor("text:Header presses: 1");
});
