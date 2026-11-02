// A tap in a scroll view hides the keyboard (keyboardShouldPersistTaps
// "never") when the focused field is outside the scroll view.
import { open, test } from "nsh/test";

test("a tap in a scroll view hides the keyboard of a field below it", async () => {
  const app = await open("./fixtures/keyboard-taps.tsx");
  await app.type("id:message", "test1");
  await app.press("text:/^Row 1/");
  await app.waitFor("text:keyboard: down");
});
