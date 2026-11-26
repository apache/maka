// Run with --target android: Android's insertText.
import { open, test } from "nsh/test";

test("insertText inserts into the input as the user's edit", async () => {
  const app = await open("./fixtures/insert-text.tsx");
  await app.type("id:field", "x");
  await app.press("id:insert");
  // A single-line input gets a space for the line break.
  await app.waitFor("Value: xa b");
});
