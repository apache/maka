// The Components demo: its cards, press feedback, the layout animation's
// boxes, the sheet, the modal, the keyboard avoiding view's screen and the
// input accessory's counter.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open(".", { clock: {} });
  await app.press("label:Components");
});

test("shows its cards and the platform's figures", () => {
  for (const text of [
    "Press feedback",
    "Fades while pressed",
    "activeStyle={{ opacity: 0.4 }}",
    "Enabled",
    "On",
    "Last pressed",
    "None yet",
    "Open a sheet",
    "active:scale-[0.97]",
    "Layout animation",
    "Spring",
    "Ease",
    "0 characters",
    "The bar counts what you type",
    "Keyboard avoidance",
    "Modal options",
    "statusBarTranslucent",
    "false",
    "Platform",
    "platform.os",
    "ios",
    "platform.version",
    "platform.idiom / catalyst",
    "phone / false",
    "ios branch",
    "pixelRatio()",
    "10.3 on whole pixels",
    "10",
    "reduceMotion()",
    "The line above is one device pixel tall",
    "1.000 pt",
  ]) {
    expect(app.texts()).toContain(text);
  }
});

test("Android sees its own branch", async () => {
  const android = await open(".", { clock: {}, platform: "android" });
  await android.press("label:Components");
  expect(android.texts()).toContain("android branch");
  expect(android.texts()).toContain("Android has no input accessories");
});

test("a tile shows what was pressed last", async () => {
  await app.press("Fades while pressed");
  await app.waitFor("Fading tile");
});

test("the layout animation adds a box first and removes it", async () => {
  // A box and the count's badge read 4 (the index has 4s of its own).
  const fours = app.count("text:4");
  await app.press("Add");
  expect(app.count("text:4")).toBe(fours + 2);
  await app.press("Remove");
  expect(app.count("text:4")).toBe(fours);
});

test("the input accessory counts what is typed and clears it", async () => {
  await app.type("text:Focus me", "Hello");
  await app.waitFor("5 characters");
  await app.press("Clear");
  await app.waitFor("0 characters");
});

test("opens the modal and the sheet, and closes them", async () => {
  await app.press("Open the modal");
  await app.waitFor("The olive background starts below the status bar on Android.");
  expect(app.texts()).toContain("opaque bar");
  await app.press("Close");
  await app.waitFor("opaque bar", { state: "gone" });

  await app.press("Open a sheet");
  for (const text of ["pageSheet", "A sheet", "Swipe down (iOS) or press back (Android) to close."]) {
    await app.waitFor(text);
  }
  await app.press("Close");
  await app.waitFor("A sheet", { state: "gone" });
});

test("pushes the keyboard inset page and switches padding and margin", async () => {
  await app.press("Keyboard inset");
  await app.waitFor("padding-bottom: env(keyboard-inset-height)");
  expect(app.texts()).toContain("The bottom pads: the tinted background stays under the keyboard.");
  await app.press("margin");
  await app.waitFor("margin-bottom: env(keyboard-inset-height)");
  expect(app.texts()).toContain("The view shrinks: its background ends at the keyboard.");
});
