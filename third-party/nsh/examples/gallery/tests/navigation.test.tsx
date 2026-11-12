// Going back: `app.back()` is the user's back (a header's back button,
// swiping a sheet down), and a screen that prevents it is asked first.
import { expect, open, test } from "nsh/test";

test("back returns to the demo index", async () => {
  const app = await open("../App.tsx", { clock: {} });
  await app.press("label:NavStack");
  await app.waitFor("Native stack");
  await app.back();
  expect(app.shows("Native stack")).toBe(false);
  expect(app.texts()).toContain("APPS");
});

test("unsaved changes ask before going back", async () => {
  const app = await open("../App.tsx", { clock: {} });
  await app.press("label:NavStack");
  await app.press("Unsaved changes");
  await app.waitFor("Nothing to lose: back pops");
  await app.type("text:A draft", "Notes");
  await app.waitFor("5 characters would be lost: back asks first");
  // The screen asks with a dialog; without an answer, its cancel button
  // keeps editing.
  await app.back();
  expect(app.dialogs()[0].title).toBe("Discard your changes?");
  expect(app.shows("5 characters would be lost: back asks first")).toBe(true);
  app.onDialog(() => "Discard");
  await app.back();
  await app.waitFor("Native stack");
});

test("a stack tells the app each change of its pages, which gives each its address", async () => {
  const app = await open("../App.tsx", { clock: {} });
  await app.press("label:NavStack");
  await app.waitFor("0 changes, 0 opens: no address");
  await app.press("label:Open Invoice");
  await app.waitFor("1 changes, 0 opens: #/messages/Invoice");
  await app.press("label:Back to the inbox");
  await app.waitFor("2 changes, 0 opens: no address");
});
