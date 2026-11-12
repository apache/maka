// Pull to refresh with UIKit's refresh control, pulled by a finger through
// IOHID. Under a large title iOS 26 moves the control into a container of
// its own: the refresh must still reach the scroll view or list that owns it,
// once per pull, and never the root (node 0).
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

async function show(app: App, page: string) {
  await app.press(`text:${page}`);
  await app.wait(700);
}

async function pull(app: App) {
  await app.drag("id:target", { x: 0, y: 360 });
}

async function end(app: App, refreshes: number) {
  await app.press("text:End");
  await app.waitFor(`text:refreshes:${refreshes} refreshing:false`);
  // The control's own end: the content settles back before the next pull.
  await app.wait(600);
}

for (const page of ["Large scroll", "Large list", "Plain scroll", "Plain list"]) {
  test(`a pull refreshes its own view once, ends and refreshes again: ${page.toLowerCase()}`, async () => {
    const app = await open("./App.tsx");
    await show(app, page);
    await pull(app);
    await app.waitFor("text:refreshes:1 refreshing:true");
    // One pull is one refresh: nothing more arrives while it runs.
    await app.wait(600);
    expect(app.shows("text:refreshes:1 refreshing:true")).toBe(true);
    await end(app, 1);
    // Only a control that ended refreshing reports another pull.
    await pull(app);
    await app.waitFor("text:refreshes:2 refreshing:true");
    await end(app, 2);
  });
}

for (const page of ["Large scroll", "Large list"]) {
  test(`a view made again refreshes through its new control: ${page.toLowerCase()}`, async () => {
    const app = await open("./App.tsx");
    await show(app, page);
    await pull(app);
    await app.waitFor("text:refreshes:1 refreshing:true");
    await app.press("text:Remove");
    await app.waitFor("text:refreshes:1 refreshing:false");
    expect(app.shows("id:target")).toBe(false);
    await app.press("text:Restore");
    await app.wait(400);
    await pull(app);
    await app.waitFor("text:refreshes:2 refreshing:true");
    await app.wait(600);
    expect(app.shows("text:refreshes:2 refreshing:true")).toBe(true);
    await end(app, 2);
  });
}

for (const page of ["Large scroll", "Large list"]) {
  test(`the same view refreshes again after onRefresh goes and comes back: ${page.toLowerCase()}`, async () => {
    const app = await open("./App.tsx");
    await show(app, page);
    await pull(app);
    await app.waitFor("text:refreshes:1 refreshing:true");
    // onRefresh off: the control goes, the view stays.
    await app.press("text:Disable");
    await app.waitFor("text:refreshes:1 refreshing:false");
    expect(app.shows("id:target")).toBe(true);
    await app.wait(400);
    await pull(app);
    await app.wait(600);
    expect(app.shows("text:refreshes:1 refreshing:false")).toBe(true);
    // onRefresh back: a new control on the same view.
    await app.press("text:Enable");
    await app.wait(400);
    await pull(app);
    await app.waitFor("text:refreshes:2 refreshing:true");
    await app.wait(600);
    expect(app.shows("text:refreshes:2 refreshing:true")).toBe(true);
    await end(app, 2);
  });
}
