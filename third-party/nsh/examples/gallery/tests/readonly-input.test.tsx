// A readonly input's text can be selected (and copied), not changed.
import { expect, open, test } from "nsh/test";

test("a long press selects a word of a readonly input", async () => {
  const app = await open("./fixtures/readonly-input.tsx");
  // Android's for now (a headless run selects no text on a long press).
  if (!app.shows("Platform: android")) return;
  await app.longPress("id:key");
  await app.waitFor("text:/^selected: test[0-9]$/");
  expect(app.value("text:test1 test2 test3")).toBe("test1 test2 test3");
});
