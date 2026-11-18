// A short label laid out after an Input keeps its one line. On Android 15 a
// TextView (an Input's EditText) leaves pooled StaticLayout builders breaking
// lines by ink bounds; NSH's text, measured by advances, then broke its last
// glyph onto a line of its own ("Wor" / "k"). Run on a device with
// `--target android`; headless, the labels are one line by construction.
import { expect, open, test } from "nsh/test";

test("short labels keep one line after an input lays out", async () => {
  const app = await open("./fixtures/text-bounds.tsx");
  await app.wait(500);
  await app.press("text:Show labels");
  for (const word of ["Work", "Week", "Today", "Toda"]) {
    await app.waitFor(`text:/^${word}: [1-9]/`);
    expect(app.texts()).toContain(`${word}: 1 line`);
  }
});
