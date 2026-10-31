// A list given other rows (search results) is pressed by what it shows now,
// not by the rows its cells showed before.
import { expect, open, test } from "nsh/test";

test("a row of new results is pressed", async () => {
  const app = await open("./fixtures/list-search.tsx");
  await app.press("Alice");
  await app.waitFor("text:picked: Alice");
  await app.type("id:search", "a");
  await app.press("Mallory");
  await app.waitFor("text:picked: Mallory");
  await app.type("id:search", "l");
  await app.press("Mallory");
  await app.waitFor("text:picked: Mallory");
  expect(app.texts()).not.toContain("Bob");
});
