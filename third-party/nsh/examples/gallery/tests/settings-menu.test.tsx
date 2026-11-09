import { expect, open, test } from "nsh/test";

test("sidebar settings stay open during changes and dismiss with Escape", async () => {
  const app = await open("../App.tsx", { platform: "linux", colorScheme: "light", width: 1100, height: 760 });
  await app.setViewport(1100, 760);
  await app.press("label:Settings menu");
  await app.waitFor("Performance monitor");
  expect(app.count("role:menuitemcheckbox")).toBe(3);
  expect(app.spanStyle("Dark appearance").color).toBe("#101319ff");
  await app.press("Dark appearance");
  expect(app.spanStyle("Dark appearance").color).toBe("#eeeff1ff");
  expect(app.shows("Sounds")).toBe(true);
  await app.press("Sounds");
  expect(app.shows("Dark appearance")).toBe(true);
  await app.keyboard.press("escape");
  expect(app.shows("Performance monitor")).toBe(false);
  await app.press("label:Settings menu");
  await app.waitFor("Dark appearance");
  await app.keyboard.press("escape");
}, 60000);
