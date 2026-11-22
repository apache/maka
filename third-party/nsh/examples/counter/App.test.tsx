import { expect, open, test } from "nsh/test";

test("counts up and down", async () => {
  const app = await open("./App.tsx");
  await app.press("+1");
  await app.press("+1");
  await app.press("−1");
  await app.waitFor("• 1");
  expect(app.texts()).toContain("1");
});
