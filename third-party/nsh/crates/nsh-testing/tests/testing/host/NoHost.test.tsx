import { expect, open, test } from "nsh/test";

test("without a page host, calls reject", async () => {
  const app = await open("./App.tsx");
  expect(app.shows("text:available: false")).toBe(true);
  await app.press("label:echo");
  await app.waitFor("text:/result: rejected: ERR_FEATURE_UNAVAILABLE_ON_PLATFORM /");
});
