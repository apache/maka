// The device as the test fixes it, on a real platform too: the locale,
// reduced motion, the safe area and the clipboard.
import { expect, open, test } from "nsh/test";

/** The value shown after `label` in the demo's rows. */
const after = (texts: string[], label: string) => texts[texts.indexOf(label) + 1];

test("the locale and reduced motion are the test's", async () => {
  const app = await open("../App.tsx", { locale: "de-DE", reducedMotion: true });
  await app.press("role:button[Patterns]");
  await app.waitFor("locale()");
  expect(after(app.texts(), "locale()")).toBe("de-DE");
  expect(after(app.texts(), "reduceMotion()")).toBe("true");
});

test("the safe area is the test's", async () => {
  const app = await open("../App.tsx", { safeArea: { top: 47, bottom: 34 } });
  await app.press("role:button[System]");
  await app.waitFor("Safe area insets");
  expect(after(app.texts(), "Top")).toBe("47");
  expect(after(app.texts(), "Bottom")).toBe("34");
});
