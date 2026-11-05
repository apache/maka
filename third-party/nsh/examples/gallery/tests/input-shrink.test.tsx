// An input that shrinks (a composer cleared after a message that wrapped)
// keeps taking what the keyboard types.
import { expect, open, test } from "nsh/test";

test("a composer cleared back to one line keeps taking keys", async () => {
  const app = await open("./fixtures/input-shrink.tsx");
  await app.type("id:composer", "test1 test2 test3 test4 test5 test6 test7 test8 test9 test10");
  await app.press("label:Send");
  expect(app.value("id:composer")).toBe("");
  await app.keyboard.press("a");
  expect(app.value("id:composer")).toBe("a");
});
