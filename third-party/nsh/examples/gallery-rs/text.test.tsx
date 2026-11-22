// The Text demo: its samples, the sentence and the button inside a
// sentence take presses.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

/** The sentence with links. */
const SENTENCE =
  "By continuing you agree to the Terms of service and the Privacy policy, which mention nested links too.";

let app: App;
beforeEach(async () => {
  app = await open(".", { clock: {} });
  await app.press("label:Text");
});

test("shows its samples", () => {
  for (const text of [
    SENTENCE,
    "Spans and links",
    "Pressed",
    "nothing yet",
    // The image, the badge and the button are inline in one paragraph.
    "Made with \u{fffc} nsh. Status \u{fffc} and a button inside the sentence \u{fffc} that takes presses of its own.",
    "LIVE",
    "♥ 3",
    "Custom fonts",
    "Pacifico-Regular.ttf",
    "Light Bold Italic Both Spaced",
    "Underline Strikethrough Both",
    "UPPERCASE Capitalized Words Here",
    "Glow",
    "Drop shadow",
    "System text size",
    "1.00×",
    "maxFontSizeMultiplier={1.2}",
    "Truncation",
    "One line, middle",
    "Centered, three lines",
    "Chinese and Japanese",
    "Japanese: kana, kanji and Latin",
    "Right to left",
    "Arabic paragraph",
    'writingDirection="rtl"',
    "Hebrew",
    "Alignment",
    "Justify, Chinese",
    "Left, in Arabic",
  ]) {
    expect(app.texts()).toContain(text);
  }
});

test("the sentence and the button inside a sentence take presses", async () => {
  await app.press(SENTENCE);
  await app.waitFor("the sentence (not a link)");
  await app.press("♥ 3");
  await app.waitFor("♥ 4");
});
