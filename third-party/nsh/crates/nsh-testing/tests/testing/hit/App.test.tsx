import { expect, open, test } from "nsh/test";

test("a press reaches a button nothing covers", async () => {
  const app = await open("./App.tsx");
  await app.press("Resume");
  expect(app.shows("Pressed: resume")).toBe(true);
});

test("a press on a covered button fails as a finger would miss it", async () => {
  const app = await open("./App.tsx");
  await expect(() => app.press("Covered")).rejects.toMatchObject({ code: "ERR_NSH_TEST_COVERED" });
  expect(app.shows("Pressed: none")).toBe(true);
});

test("a view nothing presses is not found", async () => {
  const app = await open("./App.tsx");
  await expect(() => app.press("Unbound")).rejects.toMatchObject({ code: "ERR_NSH_TEST_NOT_FOUND" });
});
