import { expect, open, test } from "nsh/test";

test("a shifted character fires its shortcut before typing", async () => {
  const app = await open("./fixtures/shift-key.tsx");
  await app.type("id:field", "x");
  await app.keyboard.press("shift+8");
  await app.waitFor("text:shortcut: 1");
  expect(app.value("id:field")).toBe("x");
});
