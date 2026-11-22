// Drags: a pan the platform drives, and a PanResponder whose positions go
// through JS.
import { expect, open, test } from "nsh/test";

test("dragging the photo pans it, and the drag says how far", async () => {
  const app = await open("../App.tsx");
  await app.press("label:Gestures");
  await app.waitFor("id:photo");
  const drag = () => app.texts()[app.texts().indexOf("Drag") + 1];
  expect(drag()).toBe("0 pt");
  await app.drag("id:photo", { x: 60, y: 80 });
  // From where the platform's recognizer took it (UIKit's after its
  // hysteresis): about the finger's 100 points.
  await app.waitUntil(() => parseInt(drag()) >= 80);
});

test("the ball follows the finger through its PanResponder", async () => {
  const app = await open("../App.tsx");
  await app.press("label:Gestures");
  await app.waitFor("id:ball");
  // Across the page: its vertical scroll view does not compete for it.
  await app.drag("id:ball", { x: 50, y: 0 });
  await app.waitFor("50, 0");
  // Let go still moving: the release has a velocity.
  expect(app.shows("Dragging")).toBe(false);
  expect(app.shows("Idle")).toBe(false);
});
