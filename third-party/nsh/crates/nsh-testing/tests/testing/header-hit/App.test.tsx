import { expect, open, test } from "nsh/test";

for (const platform of ["web", "macos", "ios"] as const) {
  test(`a press reaches a header button above a scroll view, large title, ${platform}`, async () => {
    const app = await open("./App.tsx", { platform });
    await app.waitFor("text:Content");
    await app.press("label:Back");
    expect(app.shows("Pressed: back")).toBe(true);
  });
}
