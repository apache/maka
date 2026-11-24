import { expect, open, test } from "nsh/test";

test("a reopen reaches the app's reopen listeners", async () => {
  const app = await open("./App.tsx", { platform: "macos" });
  await app.waitFor("Log: waiting");
  await app.reopen();
  await app.waitUntil(async () => (await app.storage())["flow.reopen"] === "yes");
  await app.waitFor("Log: reopened");
});

test("closing the last window reaches the app's lastWindowClosed listeners", async () => {
  const app = await open("./App.tsx", { platform: "macos" });
  await app.waitFor("Log: waiting");
  await app.window("main").pressClose();
  await app.waitUntil(() => app.window("main").state() === null);
  // macOS's default policy leaves the app running, so the app still reads
  // the storage its listener wrote.
  const storage = await app.storage();
  expect(storage["flow.lastWindowClosed"]).toBe("yes");
});
