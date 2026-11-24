import { expect, open, test } from "nsh/test";

test("typing a shared prefix after Return keeps the whole second line", async () => {
  const app = await open("../App.tsx", { platform: "macos" });
  await app.type("ed", "ab");
  await app.keyboard.press("mod+a");
  await app.keyboard.press("backspace");
  expect(app.value("ed")).toBe("");
  await app.type("ed", "\nab cd");
  expect(app.value("ed")).toBe("\nab cd");
  await app.keyboard.press("backspace");
  expect(app.value("ed")).toBe("\nab c");
});
