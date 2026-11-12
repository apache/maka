// A zoomed image in a horizontal pager pans with horizontal drags; at its
// edge the drag goes on to page, and an image not zoomed pages at once.
import { expect, open, test } from "nsh/test";

const openViewer = async () => {
  const app = await open("./fixtures/zoom-in-pager.tsx");
  await app.waitFor("text:page: 0");
  return app;
};

/** The first image's offset and the most it can be. */
function image(app: { texts(): string[] }): { x: number; max: number } {
  const [x, max] = (app.texts().find((t) => t.startsWith("image: ")) ?? "").match(/-?\d+/g)!.map(Number);
  return { x, max };
}

test("a horizontal drag on a zoomed image pans it, not the pager", async () => {
  const app = await openViewer();
  // Android's: a headless run does not zoom.
  if (!app.shows("Platform: android")) return;
  const before = image(app).x;
  await app.drag("Photo 1", { x: -120, y: 0 });
  await app.wait(600);
  expect(image(app).x).toBeGreaterThan(before + 80);
  expect(app.texts()).toContain("page: 0");
});

test("a drag past a zoomed image's edge goes on to the next page", async () => {
  const app = await openViewer();
  if (!app.shows("Platform: android")) return;
  // Zoomed in around its middle: half the zoomed width to go, then the pager's part.
  await app.drag("Photo 1", { x: -500, y: 0 });
  await app.waitFor("text:page: 1");
  const { x, max } = image(app);
  expect(max).toBeGreaterThan(0);
  expect(x).toBe(max);
});

test("a horizontal drag on an image not zoomed pages", async () => {
  const app = await openViewer();
  if (!app.shows("Platform: android")) return;
  await app.press("Zoom out");
  await app.drag("Photo 1", { x: -120, y: 0 });
  await app.waitFor("text:page: 1");
  expect(image(app).max).toBe(0);
});
