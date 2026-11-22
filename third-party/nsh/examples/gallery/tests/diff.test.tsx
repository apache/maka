// The Diff demo: `nsh/base`'s `DiffView` of an edited component, whose
// changes the app's navigator and actions walk through, revert and keep.
import { expect, open, test } from "nsh/test";

test("the Diff demo navigates, reverts and keeps changes, and shows a patch", async () => {
  const app = await open("../App.tsx");
  await app.press("role:button[DiffView]");
  // Five changes: the import, the signature and its body, the view's
  // props, the badge's limit and the step.
  await app.waitFor("+8 −8 · Change 1 of 5");
  await app.press("label:Next change");
  await app.waitFor("+8 −8 · Change 2 of 5");
  // Reverting the import puts its old line back in the new text.
  await app.press("label:Revert change 1");
  await app.waitFor("+7 −7 · Change 2 of 4");
  expect(app.shows("Changed")).toBe(true);
  // Keeping the signature's change makes its four lines the old text's.
  await app.press("label:Keep change 1");
  await app.waitFor("+3 −3 · Change 2 of 3");
  await app.press("label:Reset");
  await app.waitFor("+8 −8 · Change 2 of 5");
  // A patch: its hunks under their headers.
  await app.press("Patch");
  await app.waitFor("@@ impl Layout {");
  // Long unwrapped lines, each on its own row, and the text size shown.
  await app.press("Long lines");
  await app.waitFor("export const value9 = 9090; // a long unwrapped filler line number 9");
  await app.waitFor("Text size 1.00× · raise the system text size: every line stays on its own row");
});
