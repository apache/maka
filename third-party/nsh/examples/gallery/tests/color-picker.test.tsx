// The ColorPicker demo: a picker in place (a swatch, a typed color and the
// opacity slider change one color, reported as the picker writes it; the
// fields follow the format picked), a labelled field whose trigger opens
// the picker in a popover, a banner's overlay written as rgb(), and a theme
// token adjusted in OKLCH that keeps the channel typed.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("../App.tsx", { clock: {} });
  await app.press("role:button[ColorPicker]");
  await app.waitFor("Primary color");
});

test("a swatch, a typed color and the opacity slider change the color", async () => {
  // The area, hue and opacity in place, the token's three channels; the popovers' are closed.
  expect(app.count("role:adjustable")).toBe(6);
  await app.press("label:#ef4444");
  await app.waitFor("Picked #ef4444");
  expect(app.value("label:Fill color hex")).toBe("#ef4444");
  // Any CSS form, read when the field is submitted.
  await app.clear("label:Fill color hex");
  await app.type("label:Fill color hex", "rgb(0 128 255)");
  await app.submit("label:Fill color hex");
  await app.waitFor("Picked #0080ff");
  // Fully transparent: the opacity slider at its start.
  await app.drag("label:Fill color opacity", { x: -600, y: 0 });
  await app.waitFor("Picked #0080ff00");
});

test("the fields follow the format picked", async () => {
  await app.press("label:Fill color format, HEX");
  await app.press("RGB");
  await app.waitFor("label:Fill color red value");
  // #6366f1
  expect(app.value("label:Fill color red value")).toBe("99");
  expect(app.value("label:Fill color blue value")).toBe("241");
  expect(app.count("label:Fill color hex")).toBe(0);
});

test("a field's trigger opens the picker in a popover and shows the value", async () => {
  await app.waitFor("rgb(15 23 42 / 0.55)");
  await app.press("label:Accent color, #0ea5e9");
  await app.waitFor("label:Accent color hue");
  expect(app.count("role:adjustable")).toBe(8);
  await app.clear("label:Accent color hex");
  await app.type("label:Accent color hex", "#22c55e");
  await app.submit("label:Accent color hex");
  await app.waitFor("Accent #22c55e");
  await app.waitFor("label:Accent color, #22c55e");
});

test("a channel typed is kept", async () => {
  await app.clear("label:Primary Lightness value");
  await app.type("label:Primary Lightness value", "70");
  await app.submit("label:Primary Lightness value");
  await app.waitFor("--primary: oklch(70% 0.215 262.9)");
});
