// `nsh test` runs this file in a headless runner it builds with the crate:
// the count lives in Rust (`Counter`), its wording too (`Format.times`).
import { expect, open, test } from "nsh/test";

test("counts presses", async () => {
  const app = await open("./App.tsx");
  expect(app.texts()).toContain("Not pressed yet");
  await app.press("Press me");
  await app.press("Press me");
  expect(app.texts()).toContain("Pressed twice");
});
