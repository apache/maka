import { expect, open, test } from "nsh/test";

for (const platform of ["ios", "macos", "web"] as const) {
  test(`a custom hold keeps the ${platform} pointer and scroll behavior`, async () => {
    const app = await open("../drag-pointer/App.tsx", { platform });
    await app.drag("id:row", { y: -300 }, { hold: 100 });
    expect(app.shows(`Pointer: ${platform === "ios" ? "touch" : "mouse"}`)).toBe(true);
    expect(app.shows(`Scrolled: ${platform === "ios" ? "yes" : "no"}`)).toBe(true);
  });
}

test("a custom hold keeps mouse text selection", async () => {
  const app = await open("../text-selection/App.tsx", { platform: "macos" });
  await app.drag("id:first", { y: 17 }, { hold: 100 });
  await app.waitFor('Selected: " beta\\nGamma"');
});
