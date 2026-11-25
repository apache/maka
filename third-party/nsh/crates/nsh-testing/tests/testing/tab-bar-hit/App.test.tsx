import { expect, open, test } from "nsh/test";

test("a press reaches a control under a tab bar out of sight", async () => {
  const app = await open("./App.tsx");
  await app.press("Bottom");
  expect(app.shows("Pressed: bottom")).toBe(true);
});
