// The ColorPicker demo: a swatch, a typed color, the channels of the space
// picked and the alpha slider change one color, reported as the picker
// writes it; a theme token adjusted in OKLCH keeps the channel typed.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("../App.tsx", { clock: {} });
  await app.press("role:button[ColorPicker]");
  await app.waitFor("#3b82f6");
});

test("a swatch, a typed color and the alpha slider change the color", async () => {
  // The area, hue and alpha, HSB's three channels, the token's three.
  expect(app.count("role:adjustable")).toBe(9);
  await app.press("label:#ef4444");
  await app.waitFor("Picked #ef4444");
  expect(app.value("label:Color")).toBe("#ef4444");
  expect(app.value("label:HSB Hue value")).toBe("0");
  // Any CSS form, read when the field is submitted.
  await app.clear("label:Color");
  await app.type("label:Color", "rgb(0 128 255)");
  await app.submit("label:Color");
  await app.waitFor("Picked #0080ff");
  // Fully transparent: the alpha slider at its start.
  await app.drag("label:Alpha", { x: -600, y: 0 });
  await app.waitFor("Picked #0080ff00");
});

test("the channels follow the space picked, and a channel typed is kept", async () => {
  await app.press("OKLCH");
  await app.waitFor("OKLCH Lightness");
  expect(app.count("role:adjustable")).toBe(9);
  expect(app.value("label:OKLCH Hue value")).toBe("259.8");
  await app.clear("label:Primary Lightness value");
  await app.type("label:Primary Lightness value", "70");
  await app.submit("label:Primary Lightness value");
  await app.waitFor("--primary: oklch(70% 0.215 262.9)");
});
