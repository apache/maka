// The chat's "Choose a photo": `Picker.pickImages` shows the system's
// picker; the test answers it with a file of its own (`app.onPick`), which
// the composer shows by its name and size.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

// A 2×1 PNG.
const png = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwnwEIGAEAJesD/c0O6VMAAAAASUVORK5CYII="),
  (c) => c.charCodeAt(0),
);

let app: App;
beforeEach(async () => {
  app = await open("../App.tsx", { clock: {} });
  await app.press("role:button[AI Chat]");
  await app.waitFor("label:Add");
});

test("a photo the user picks shows in the composer", async () => {
  app.onPick((pick) => {
    expect(pick.multiple).toBe(false);
    expect(pick.maxDimension).toBe(2048);
    return [{ name: "harbor.png", type: "image/png", data: png }];
  });
  await app.press("label:Add");
  await app.press("label:Choose a photo");
  await app.waitFor("harbor.png");
  expect(app.texts()).toContain("PNG · 1 KB");
  expect(app.picks().length).toBe(1);
});

test("cancelling the picker attaches nothing", async () => {
  await app.press("label:Add");
  await app.press("label:Choose a photo");
  expect(app.picks().length).toBe(1);
  expect(app.shows("harbor.png")).toBe(false);
});
