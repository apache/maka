import { expect, open, test } from "nsh/test";

test("without a page host, calls reject", async () => {
  const app = await open("./App.tsx");
  expect(app.shows("text:available: false")).toBe(true);
  await app.press("label:echo");
  await app.waitFor("text:/result: rejected: ERR_FEATURE_UNAVAILABLE_ON_PLATFORM /");
});

test("a module's stand-in does not make the test an embedding app", async () => {
  const app = await open("./App.tsx", { modules: { nsh: { "Image.prefetch": async () => true } } });
  expect(app.shows("text:available: false")).toBe(true);
  await app.press("label:echo");
  await app.waitFor("text:/result: rejected: ERR_FEATURE_UNAVAILABLE_ON_PLATFORM /");
});

test("without a page host, posts are dropped", async () => {
  const app = await open("./App.tsx");
  await app.press("label:post other");
  await app.waitFor("text:result: posted");
});
