import { expect, open, test } from "nsh/test";

// `pasteBehavior="report"` inserts nothing: the app hears the paste first
// and inserts what it allows with `insertText`, as the user's edit.

test("an allowed paste goes in as the app inserts it", async () => {
  const app = await open("./App.tsx");
  await app.type("id:field", "hello ");
  await app.paste("id:field", { text: "world" });
  await app.waitFor("Paste: allowed");
  expect(app.value("id:field")).toBe("hello world");
});

test("a rewritten paste goes in rewritten", async () => {
  const app = await open("./App.tsx");
  await app.paste("id:field", { text: "shout:quiet" });
  await app.waitFor("Paste: rewritten");
  expect(app.value("id:field")).toBe("QUIET");
});

test("a cancelled paste inserts nothing", async () => {
  const app = await open("./App.tsx");
  await app.type("id:field", "keep");
  await app.paste("id:field", { text: "secret token" });
  await app.waitFor("Paste: cancelled");
  expect(app.value("id:field")).toBe("keep");
});
