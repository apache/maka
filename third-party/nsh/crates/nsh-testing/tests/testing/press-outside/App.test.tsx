import { expect, open, test } from "nsh/test";

test("a press tells an overlay's onPressOutside where the finger went down", async () => {
  const app = await open("./App.tsx");
  await app.press("id:button");
  expect(app.shows("Outside: 282 30")).toBe(true);
});

test("a press at a position tells it that point", async () => {
  const app = await open("./App.tsx");
  await app.press("id:button", { position: { x: 4, y: 6 } });
  expect(app.shows("Outside: 260 22")).toBe(true);
});
