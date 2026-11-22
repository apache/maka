// The mouse over a view: in, move and out (a desktop: headless, the app
// runs as macOS; on a real platform, as it).
import { expect, open, test } from "nsh/test";

// A menu bar is the desktop's: a browser page narrower than 600 points is a
// phone, whose menus are sheets over a backdrop that covers the bar.
const desktop = { platform: "macos", width: 1200, height: 800 } as const;

test("the pad hears the pointer come in, move and leave", async () => {
  const app = await open("../App.tsx", { platform: "macos" });
  await app.press("label:Gestures");
  await app.waitFor("Pointer away");
  await app.hover("id:hover-pad");
  // Its middle: half of its width, 50 of its 100 points.
  await app.waitFor("text:/^Pointer at \\d+, 50$/");
  expect(app.shows("Over")).toBe(true);
  await app.hover("Hover");
  await app.waitFor("Pointer away");
});

test("with a menu of the menu bar open, the pointer over another title opens it", async () => {
  const app = await open("../App.tsx", desktop);
  await app.press("role:button[Menu]");
  await app.waitFor("Menu bar");
  await app.press("File");
  await app.waitFor("New document");
  await app.hover("Edit");
  await app.waitFor("Undo");
  expect(app.shows("New document")).toBe(false);
  await app.hover("View");
  await app.waitFor("Show sidebar");
  expect(app.shows("Undo")).toBe(false);
});

test("the pointer over a closed menu bar opens nothing", async () => {
  const app = await open("../App.tsx", desktop);
  await app.press("role:button[Menu]");
  await app.waitFor("Menu bar");
  await app.hover("Edit");
  await app.wait(300);
  expect(app.shows("Undo")).toBe(false);
});
