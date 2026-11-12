import { expect, open, test } from "nsh/test";

test("forward rejects off the web: only the browser's history goes forward", async () => {
  const app = await open("./App.tsx");
  await expect(app.forward()).rejects.toMatchObject({ code: "ERR_NSH_TEST_UNSUPPORTED" });
  await expect(app.forward()).rejects.toThrow("--target web");
  expect(app.shows("Home")).toBe(true);
});
