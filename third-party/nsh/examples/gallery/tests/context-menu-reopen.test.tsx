// A secondary click on the trigger of an open context menu closes it and
// opens it again where the pointer is, also when the app owns `open`; one
// on another view closes it.
import { expect, open, test } from "nsh/test";

test("a secondary click on an open context menu's trigger opens it again", async () => {
  const app = await open("./fixtures/context-menu-controlled.tsx", { platform: "macos" });
  await app.rightClick("text:row");
  await app.waitFor("text:menu-row");
  await app.rightClick("text:row");
  await app.waitFor("text:changes: oco");
  await app.wait(300);
  expect(app.count("text:menu-row")).toBe(1);
  await app.rightClick("text:other");
  await app.waitFor("text:changes: ococ");
  await app.waitFor("text:menu-row", { state: "gone" });
});
