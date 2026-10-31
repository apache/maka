// The Styles and Typed styles demos: their cards, the clipping and
// stacking tiles take taps, "Flip" lays the surface out right to left and
// back, the typed buttons keep their state.
import { expect, open, test } from "nsh/test";

test("the Styles demo shows its cards", async () => {
  const app = await open(".", { clock: {} });
  await app.press("label:Styles");
  for (const text of [
    "Corners",
    "Continuous",
    "Top corners",
    "Mixed radii",
    "Per-side borders",
    "Dashed / dotted",
    "Shadows and glow",
    "Glow",
    "Offset shadow",
    "Shadow",
    "Text corners",
    "Elevation",
    "Clipped",
    "overflow: hidden",
    "Stacking order",
    "Front: 1 of 3 · tap",
    "0.45",
    "Perspective",
    "rotateX: 40deg",
    "Skew",
    "Tap to flip",
    "backfaceVisibility",
    "1,111.11",
    "Small Caps",
    "Right to left",
    "direction: ltr",
    "12",
  ]) {
    expect(app.texts()).toContain(text);
  }
});

test("the layer tiles take taps", async () => {
  const app = await open(".", { clock: {} });
  await app.press("label:Styles");
  await app.press("Tap");
  await app.waitFor("Visible");
  expect(app.texts()).toContain("overflow: visible");
  await app.press("Tap");
  await app.waitFor("Clipped");
  await app.press("id:stacking");
  await app.waitFor("Front: 2 of 3 · tap");
});

test("flip lays the card out right to left and back", async () => {
  const app = await open(".", { clock: {} });
  await app.press("label:Styles");
  await app.press("Flip");
  await app.waitFor("text:direction: rtl");
  await app.press("Flip");
  await app.waitFor("text:direction: ltr");
});

test("the Typed styles demo shows every card", async () => {
  const app = await open(".", { clock: {} });
  await app.press("label:Typed styles");
  for (const text of [
    "Resolved natively",
    ".dark(..)",
    "This screen, styled with typed methods",
    "13 cards",
    "Stat grid",
    "40",
    "8 hues × 5 shades",
    "Buttons",
    "Cards and badges",
    "Group press",
    "Pending",
    "Flex, grid, breakpoints",
    "col-span-2",
    "row-span-2",
    "Shadows, rings, outlines",
    "2xl",
    "Glow",
    "Gradients",
    "45°",
    "Typography",
    "Display",
    "CAPS",
    "Filters and blur",
    "blur-sm",
    "Animations and transforms",
    "Bounce",
    "Structural variants",
    "Archive",
    "Inputs",
    "Palette",
    "emerald",
  ]) {
    expect(app.texts()).toContain(text);
  }
});

test("the typed buttons keep their state", async () => {
  const app = await open(".", { clock: {} });
  await app.press("label:Typed styles");
  await app.press("Pressed 0×");
  await app.press("Pressed 1×");
  await app.waitFor("Pressed 2×");
  await app.press("Reset");
  await app.waitFor("Pressed 0×");
  await app.press("Disable me");
  await app.waitFor("Disabled");
  await app.press("Enable again");
  await app.waitFor("Disable me");
});
