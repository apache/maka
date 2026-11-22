// A selection across a TextView's formulas keeps them in its Markdown
// (#2121): a copy leaves a formula out, yet the formula, inline or a block,
// is in the selected part. Linux only (a headless run draws no text).
import { expect, open, test } from "nsh/test";

test("a selection across a formula keeps it", async () => {
  const app = await open("./fixtures/selection-formula.tsx", { width: 520, height: 700 });
  if (!app.shows("Platform: linux")) return;
  // From the first line into the last (the distances are for this window).
  const markdown = async (name: string, first: string, dy: number) => {
    await app.drag(`text:${first}`, { x: 0, y: dy });
    await app.waitUntil(() => app.texts().some((t) => t.startsWith(`${name} [`) && t !== `${name} []`));
    return app.texts().find((t) => t.startsWith(`${name} [`))!;
  };
  expect(await markdown("inline", "First two", 74)).toContain("Alpha $x^2$ omega");
  expect(await markdown("block", "First three", 72)).toContain("$$");
});
