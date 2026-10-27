// The Gestures and Physics demos: presses are logged and counted, taps
// reach the button under the overlay, labelled items report presses, the
// physics card's modes change what a release does.
import { expect, open, test } from "nsh/test";

test("the Gestures demo shows its cards", async () => {
  const app = await open(".", { clock: {} });
  await app.press("label:Gestures");
  for (const text of [
    "Pan, pinch and rotation",
    "Pinch and rotate with two fingers (Option-drag in the simulator).",
    "1.00×",
    "0°",
    "PanResponder",
    "Positions go through Rust; the page does not scroll",
    "Idle",
    "Press events",
    "No events yet",
    "No touches yet",
    "0 down",
    "Touch here, try two fingers",
    "0 taps",
    "hitSlop={30}",
    'pointerEvents: "none"',
    "Long press after 250 ms",
    "pressIn",
    "longPress",
    "Starts the song",
  ]) {
    expect(app.texts()).toContain(text);
  }
});

test("presses are counted, through the overlay too, and labelled items report theirs", async () => {
  const app = await open(".", { clock: {} });
  await app.press("label:Gestures");
  // Taps go through the hatched overlay to the button.
  const zeros = app.count("text:0");
  await app.press("Button under an overlay");
  expect(app.count("text:0")).toBe(zeros - 1);
  expect(app.count("text:1")).toBe(1);
  // A tap logs its events, newest first, and counts them.
  await app.press("Tap, hold, or slide off");
  expect(app.texts()).toContain("press · pressOut · pressIn");
  expect(app.texts()).toContain("3");
  // A labelled item shows its label in the card's badge.
  expect(app.count("text:Like")).toBe(1);
  await app.press("label:Like");
  expect(app.count("text:Like")).toBe(2);
  await app.press("Center");
  expect(app.texts()).toContain("0, 0");
});

test("the Physics demo's modes change what a release does", async () => {
  const app = await open(".", { clock: {} });
  await app.press("label:Physics");
  for (const text of [
    "Drag and release",
    "Tap to pulse, long press to reset",
    "UI thread",
    "Springs home with the release velocity",
    "Spring",
    "Coast",
    "Snap",
    "Bouncy",
    "Releases",
    "0 pt/s",
    "180 / 11",
  ]) {
    expect(app.texts()).toContain(text);
  }
  await app.press("Coast");
  await app.waitFor("Coasts to a stop, then springs home");
  expect(app.texts()).toContain("decay");
  // A tap pulses the card and a long press resets the figures: no
  // release is counted.
  await app.press("Drag me");
  await app.longPress("Drag me");
  const texts = app.texts();
  expect(texts[texts.indexOf("Releases") + 1]).toBe("0");
});
