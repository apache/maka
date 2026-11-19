import { expect, open, test } from "nsh/test";

test("sidebar settings stay open during changes and dismiss with Escape", async () => {
  const app = await open("../App.tsx", { platform: "linux", colorScheme: "light", width: 1100, height: 760 });
  await app.setViewport(1100, 760);
  await app.press("label:Settings menu");
  await app.waitFor("FPS");
  expect(app.count("role:menuitemcheckbox")).toBe(3);
  expect(app.count("role:menuitemradio")).toBe(3);
  expect(app.spanStyle("Theme").color).toBe("#101319ff");
  await app.press("label:Dark");
  expect(app.spanStyle("Theme").color).toBe("#eeeff1ff");
  await app.press("role:menuitemradio >> nth=0");
  expect(app.spanStyle("Theme").color).toBe("#101319ff");
  expect(app.shows("Sounds")).toBe(true);
  await app.press("Sounds");
  expect(app.shows("Theme")).toBe(true);
  await app.press("RTL");
  expect(app.shows("RTL")).toBe(true);
  await app.keyboard.press("escape");
  expect(app.shows("FPS")).toBe(false);
  await app.press("label:Settings menu");
  await app.waitFor("Theme");
  await app.keyboard.press("escape");
}, 60000);
