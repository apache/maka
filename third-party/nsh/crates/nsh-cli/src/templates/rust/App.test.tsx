// The Rust root tested from TypeScript: `nsh test` runs this file in a
// headless runner it builds with the crate, and `open(".")` starts the root
// (`nsh.json` "root").
import { expect, open, test } from "nsh/test";

test("counts taps", async () => {
  const app = await open(".");
  expect(app.texts()).toContain("Count: 0");
  await app.press("Tap");
  await app.press("Tap");
  expect(app.texts()).toContain("Count: 2");
});
