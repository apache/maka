// UIKit regression: run this directory with `nsh test --target ios`, on a
// device that keeps its bar along one side of the screen (the iPhone Duo's
// outer display; elsewhere there is no side bar and the test passes as is).
// A header that changes while a container transforms the stack (a push
// drawer moving it aside and shrinking it) is laid out by UIKit from the
// transformed picture, which puts the side bar's buttons over the page; the
// transform going back starts no layout pass, so they must not stay there.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

/** Presses every cell across the page: a press fails when a system bar
 * covers the cell. */
async function pressCells(app: App, before: number) {
  for (let n = 0; n < 5; n++) {
    await app.press(`id:cell-${n}`);
    await app.waitFor(`text:Cell presses: ${before + n + 1}`);
  }
}

test("a header changed while a drawer moves the stack leaves the page uncovered once it is back", async () => {
  const app = await open("./Drawer.tsx");
  await app.waitFor("text:Page: Home");
  await app.wait(800);
  await pressCells(app, 0);
  await app.press("label:Menu");
  await app.waitFor("text:Drawer: open");
  await app.wait(600);
  // The header changes in the same turn that starts closing the drawer.
  await app.press("text:Show results");
  await app.waitFor("text:Page: Results");
  await app.waitFor("text:Drawer: closed");
  await app.wait(1000);
  await pressCells(app, 5);
  await app.press("id:filter");
  await app.waitFor("text:Header presses: 1");
  expect(app.shows("text:Page: Results")).toBe(true);
});
