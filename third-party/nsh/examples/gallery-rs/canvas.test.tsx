// The Canvas demo: its cards and the dial's presets.
import { expect, open, test } from "nsh/test";

test("shows its cards", async () => {
  const app = await open(".", { clock: {} });
  await app.press("label:Canvas");
  for (const text of [
    "Turbine 3 load",
    "Cruise",
    "Nominal",
    "7,296 rpm",
    "Relay throughput",
    "New",
    "Footfall by hour",
    "Peak 12:00–14:00",
    "Beacon uptime",
    "Incident",
    "Route latency",
    "Regressed",
    "Transforms",
    "Native loop",
    "Path2D",
    "Heart",
    "Check",
    "Compositing",
    "Radial gradient",
    "Sketch",
    "Clear",
    "5 · 25 points",
  ]) {
    expect(app.texts()).toContain(text);
  }
});

test("a preset sets the dial", async () => {
  const app = await open(".", { clock: {} });
  await app.press("label:Canvas");
  await app.press("Peak");
  await app.waitFor("Redline");
  expect(app.texts()).toContain("11,648 rpm");
});
