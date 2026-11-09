// The Carousel demo: an onboarding the app steps through with its own
// buttons and its dots, a launch pad's photos with arrows that stop at the
// ends and thumbnails, banners the app's timer rolls on past the last to
// the first until paused (on hold under the pointer on a desktop and while
// a finger drags them), and a swipe that reports the photo it rests on. On
// a manual clock: the app's timer moves only as the test moves time.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("../App.tsx", { clock: {} });
  // A tall phone: every card in view.
  await app.setViewport(390, 3200);
  await app.press("role:button[Carousel]");
  await app.waitFor("Onboarding");
});

// The onboarding's own buttons, inside its carousel: the gallery's page
// has a Back of its own.
const back = "label:Getting started >> role:button[Back]";
const next = "label:Getting started >> role:button[Next]";

test("the onboarding steps with its buttons and its dots, then finishes", async () => {
  await app.waitFor("Step 1 of 4");
  expect(app.enabled(back)).toBe(false);
  await app.press(next);
  await app.waitFor("Step 2 of 4");
  await app.waitFor("Onboarding: next to 2");
  expect(app.enabled(back)).toBe(true);
  // A dot goes to its step: the carousel reports it, the app follows.
  await app.press("role:button[Step 4: Stay in the loop]");
  await app.waitFor("Step 4 of 4");
  await app.waitFor("Onboarding: step 4");
  // The last step's button finishes.
  await app.press("role:button[Done]");
  await app.waitFor("You are all set");
  await app.waitFor("Onboarding: done");
  await app.press("role:button[Start over]");
  await app.waitFor("Step 1 of 4");
});

test("the photo arrows stop at the ends and a thumbnail picks a photo", async () => {
  await app.waitFor("1 / 6");
  expect(app.enabled("role:button[Previous photo]")).toBe(false);
  await app.press("role:button[Next photo]");
  await app.waitFor("2 / 6");
  await app.waitFor("Photo: Fairing, close up");
  expect(app.enabled("role:button[Previous photo]")).toBe(true);
  await app.press("role:button[Photo 6: Liftoff]");
  await app.waitFor("6 / 6");
  await app.waitFor("Photo: Liftoff");
  expect(app.enabled("role:button[Next photo]")).toBe(false);
  await app.press("role:button[Previous photo]");
  await app.waitFor("5 / 6");
});

test("a swipe reports the photo it rests on", async () => {
  await app.waitFor("1 / 6");
  // Most of a photo's width: it lands on the second.
  await app.scroll("role:group[1 of 6: On the pad at dusk]", 250);
  await app.waitFor("2 / 6");
  await app.waitFor("Photo: Fairing, close up");
  // Back a little: the second again, nothing reported.
  await app.scroll("role:group[2 of 6: Fairing, close up]", -60);
  await app.clock!.runFor(100);
  expect(app.shows("2 / 6")).toBe(true);
});

test("the app's timer rolls the banners on every 4 s, past the last to the first, until paused", async () => {
  await app.waitFor("Playing");
  await app.waitFor("1 / 4");
  // Each change starts the interval again: a little past each 4 s.
  await app.clock!.runFor(4100);
  await app.waitFor("2 / 4");
  await app.waitFor("Banner: Up to 40% off");
  await app.clock!.runFor(8200);
  await app.waitFor("4 / 4");
  // Past the last, around to the first.
  await app.clock!.runFor(4100);
  await app.waitFor("1 / 4");
  // The rotation control stops it.
  await app.press("role:button[Pause slides]");
  await app.waitFor("Paused");
  await app.clock!.runFor(12000);
  expect(app.shows("1 / 4")).toBe(true);
  await app.press("role:button[Play slides]");
  await app.waitFor("Playing");
  await app.clock!.runFor(4100);
  await app.waitFor("2 / 4");
});

test("on a desktop the banners are on hold while the pointer is over them", async () => {
  const desk = await open("../App.tsx", { platform: "macos", clock: {} });
  await desk.setViewport(1400, 2400);
  await desk.press("label:Carousel");
  await desk.waitFor("Launch season");
  await desk.hover("Launch season");
  await desk.waitFor("On hold");
  await desk.clock!.runFor(9000);
  expect(desk.shows("1 / 4")).toBe(true);
  // The pointer leaves: a whole interval from then.
  await desk.hover("Last event");
  await desk.clock!.runFor(4100);
  await desk.waitFor("2 / 4");
});

test("the banners are on hold while a finger drags them", async () => {
  await app.waitFor("Playing");
  // The carousel reports the drag (onDragStart): the app holds its timer.
  await app.dragAndHold("role:group[1 of 4: Launch season]", { x: -40, y: 0 });
  await app.waitFor("On hold");
  await app.clock!.runFor(9000);
  expect(app.shows("1 / 4")).toBe(true);
  // Let go: back where it was, the timer runs again (onDragEnd).
  await app.drop();
  await app.waitFor("Playing");
  await app.clock!.runFor(4100);
  await app.waitFor("2 / 4");
});
