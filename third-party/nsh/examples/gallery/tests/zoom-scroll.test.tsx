// A zoomable scroll view on the desktops that draw zoomed content: `zoomTo`
// scales its content, presses land on the tile drawn under the pointer, and
// the zoomed content scrolls (a headless run does not zoom).
import { expect, open, test } from "nsh/test";

const desktop = { width: 480, height: 560 } as const;

test("zoomTo scales the content, which takes presses and scrolls where it is drawn", async () => {
  const app = await open("./fixtures/zoom-scroll.tsx", desktop);
  if (!["macos", "windows"].some((os) => app.shows(`OS: ${os}`))) return;
  await app.waitFor("text:zoom=1.00 y=0");
  // Zoomed 2× around the content's corner: tile 5 (80 pt at 80, 80) is
  // drawn at 160, 160 and 160 pt wide.
  await app.press("Zoom to the first tile");
  await app.waitFor("text:zoom=2.00 y=0");
  await app.press("label:Tile 5");
  await app.waitFor("text:pressed=5");
  // The zoomed content is 640 pt tall in a 320 pt viewport: it scrolls.
  await app.scroll("id:zoom", 200);
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("zoom=2.00") && t !== "zoom=2.00 y=0"));
  await app.press("Fit");
  await app.waitFor("text:zoom=1.00 y=0");
  await app.press("label:Tile 5");
  expect(app.shows("text:pressed=5")).toBe(true);
});
