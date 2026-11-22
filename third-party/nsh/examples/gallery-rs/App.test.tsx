// A Rust app tested from TypeScript: `nsh test` runs this file in the
// headless runner it builds with the app's crate, and `open(".")` starts
// the app's root (`nsh.json` "root"). The steps and checks are the same as
// for a TSX app's.
import { expect, open, test } from "nsh/test";

test("the storage demo keeps what the Rust code writes", async () => {
  const app = await open(".", { storage: { launches: "2" } });
  await app.press("Storage");
  await app.waitFor('set_item("launches", "3")');
  await app.type("text:Write something, then come back to it", "From a test");
  await app.waitFor("11 chars");
  expect(app.storage().note).toBe("From a test");
});
