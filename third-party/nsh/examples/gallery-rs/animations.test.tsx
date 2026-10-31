// The Animations demo on a manual clock: compositions run to their end
// and report it, a loop goes on until stopped, a reset stops a run, the
// chips, the race, the interpolation and the layout's buttons follow their
// state.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open(".", { clock: {} });
  await app.press("label:Animations");
});

test("shows its cards", () => {
  for (const text of [
    "Native motion",
    "Animated.stagger",
    "Easing",
    "Side by side",
    "Composition",
    "Springs",
    "Interpolation",
    "Hiding header",
    "Layout animation",
    "bounce out",
    "Wobbly 180 / 8",
    "idle",
    "Search",
    "Row 30",
    "diffClamp(0, 52)",
    "t = 0",
    "5 views",
  ]) {
    expect(app.texts()).toContain(text);
  }
});

test("a composition runs to its end and reports it", async () => {
  await app.press("Stagger");
  await app.waitFor("stagger running");
  await app.clock!.runFor(3000);
  await app.waitFor("stagger finished");
});

test("a loop goes on until stopped, and a reset stops a run", async () => {
  await app.press("Loop");
  await app.clock!.runFor(1000);
  await app.waitFor("loop running");
  await app.press("Stop");
  await app.waitFor("loop stopped");
  await app.press("Loop");
  await app.waitFor("loop running");
  await app.press("Reset");
  await app.waitFor("loop stopped");
  // A step lets a short run play to its end.
  await app.press("Sequence");
  await app.waitFor("sequence finished");
});

test("the chips, the race, the interpolation and the layout follow their state", async () => {
  // A curve's chip plays it; the race reverses once played.
  await app.press("text:linear >> nth=0");
  await app.press("text:Play >> nth=1");
  await app.waitFor("Reverse");
  // The badge follows the segment.
  await app.press("t = 2");
  expect(app.count("text:t = 2")).toBe(2);
  await app.press("Column");
  await app.waitFor("Row");
  await app.press("Row");
  await app.waitFor("Column");
  await app.press("Add");
  await app.waitFor("6 views");
  await app.press("Remove");
  await app.press("Remove");
  await app.waitFor("4 views");
});
