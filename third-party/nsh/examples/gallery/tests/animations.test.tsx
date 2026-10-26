// Motions: presets grouped by what they are for, played on a tap.
import { expect, open, test } from "nsh/test";

test("the motion presets switch groups and play on a tap", async () => {
  const app = await open("../App.tsx");
  await app.press("label:Animations");
  await app.waitFor("Motion presets");
  for (const title of ["Staggered entrance", "Keyframes", "Aurora"]) expect(app.shows(title)).toBe(true);
  // Attention seekers first.
  expect(app.shows("shake")).toBe(true);
  expect(app.shows("fadeOut")).toBe(false);
  await app.press("role:button[shake]");
  await app.press("role:tab[Exit]");
  await app.waitFor("fadeOut");
  expect(app.shows("shake")).toBe(false);
  // An exit comes back after it plays.
  await app.press("role:button[fadeOut]");
  await app.wait(1200);
  expect(app.shows("fadeOut")).toBe(true);
});
