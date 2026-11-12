import { expect, open, test } from "nsh/test";

test("a panel removed under the pointer hears no leave", async () => {
  const app = await open("./App.tsx", { platform: "macos" });
  await app.hover("id:panel-a");
  await app.press("Open B");
  await app.waitFor("Open: b");
  await app.hover("id:panel-b");
  expect(app.shows("Open: b")).toBe(true);
});

test("an input removed while focused takes no keys", async () => {
  const app = await open("./Focus.tsx", { platform: "macos" });
  await app.type("id:field", "hi");
  await app.press("Close");
  await app.keyboard.press("enter");
  expect(app.shows("Submitted: no")).toBe(true);
});
