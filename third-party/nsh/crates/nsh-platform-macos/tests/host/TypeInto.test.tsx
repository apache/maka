// `captureKeys="text"` on the macOS host (`nsh test
// crates/nsh-platform-macos/tests/host --target macos`): with a selectable
// view focused, a typing key focuses the rule's `Input` and is delivered
// to its editor, Option keys included, and shortcuts and named keys stay
// where they are. A test's key events carry their characters, so a real
// dead key or input method composing is not exercised here.
import { expect, open, test } from "nsh/test";

test("typing on a selectable view moves into the Input", async () => {
  const app = await open("./TypeInto.tsx", { width: 400, height: 300 });
  // A drag selects and gives the selectable view the keyboard.
  await app.drag("text:Select a few words of this sentence", { x: -60, y: 0 });
  // Named keys and shortcuts stay with the selectable view.
  await app.keyboard.press("escape");
  await app.waitFor("Key: Escape");
  await app.keyboard.press("left");
  await app.waitFor("Key: ArrowLeft");
  expect(app.shows("Value: ")).toBe(true);
  // A letter moves into the input and types there.
  await app.keyboard.press("h");
  await app.waitFor("Value: h");
  // The input has the keyboard now: the next keys type as usual.
  await app.keyboard.press("i");
  await app.waitFor("Value: hi");
});

test("an Option key types, so it moves into the Input too", async () => {
  const app = await open("./TypeInto.tsx", { width: 400, height: 300 });
  await app.drag("text:Select a few words of this sentence", { x: -60, y: 0 });
  // Command+A selects the transcript and stays with it.
  await app.keyboard.press("mod+a");
  await app.waitFor("Key: a");
  expect(app.shows("Value: ")).toBe(true);
  // Option types characters on a Mac (and the U.S. layout's dead keys).
  await app.keyboard.press("alt+e");
  await app.waitFor("Key: e moved");
});
