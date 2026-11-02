// The Toggle demo: a text toolbar whose marks any number press and whose
// alignment keeps exactly one, a segmented view switcher, favorite stars,
// and a toolbar the app locks. Each toggle reports the value it asks for
// and shows the one the demo passes back.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("../App.tsx", { clock: {} });
  await app.press("role:button[Toggle]");
  await app.waitFor("Text formatting");
});

test("marks press any number at once; the alignment keeps exactly one", async () => {
  expect(app.count("role:toolbar")).toBe(3);
  await app.press("label:Italic");
  await app.waitFor("Italic: on");
  await app.waitFor("2 of 4 · left");
  await app.press("label:Bold");
  await app.waitFor("Bold: off");
  await app.waitFor("1 of 4 · left");
  await app.press("label:Align center");
  await app.waitFor("Align: center");
  await app.waitFor("1 of 4 · center");
  // The pressed alignment stays pressed.
  await app.press("label:Align center");
  await app.waitFor("Align: center (stays)");
  await app.waitFor("1 of 4 · center");
});

test("the view switcher shows one view, and a favorite star counts its press", async () => {
  await app.press("label:List view");
  await app.waitFor("View: list");
  await app.waitFor("PDF · 2.4 MB");
  await app.press("label:Grid view");
  await app.waitFor("View: grid");
  expect(app.shows("PDF · 2.4 MB")).toBe(false);
  await app.press("label:Star Q3 report");
  await app.waitFor("Q3 report: starred");
  await app.waitFor("42");
  await app.waitFor("2 starred");
  await app.press("label:Star Launch checklist");
  await app.waitFor("Launch checklist: unstarred");
  await app.waitFor("1 starred");
});

test("a locked toolbar disables every toggle in it", async () => {
  expect(app.enabled("label:Notify")).toBe(true);
  expect(app.enabled("label:Edit (view only)")).toBe(false);
  await app.press("label:Lock toolbar");
  await app.waitFor("Locked: no presses, no focus, dimmed for screen readers");
  for (const label of ["Notify", "Share link", "Comments"]) expect(app.enabled(`label:${label}`)).toBe(false);
  await app.press("label:Lock toolbar");
  await app.press("label:Notify");
  await app.waitFor("Notify: on");
});
