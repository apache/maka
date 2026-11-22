// A window of the app's own focuses nothing by itself: AppKit would give a
// window that becomes key its first field (its text selected); NSH leaves
// the focus to the user and the app, as in the main window.
import { expect, open, test } from "nsh/test";

const FIXTURE = "./fixtures/window-focus.tsx";
const OPTIONS = { platform: "macos", width: 900, height: 700 } as const;

test("a window's first field is not focused until the user focuses it", async () => {
  const app = await open(FIXTURE, OPTIONS);
  await app.press("Open inspector");
  await app.waitFor("text:Inspector body");
  // A press on the panel's background gives the panel the keyboard.
  await app.press("id:body");
  await app.wait(300);
  expect(app.shows("Field focus: none")).toBe(true);
  // Typing into the field focuses it.
  await app.type("label:Title", "s");
  await app.waitFor("Field focus: title");
});
