import { expect, open, test } from "nsh/test";

// On a platform whose inputs keep an undo history (Linux, the web): text
// the app inserts with `insertText` is one step of it.
// `nsh test crates/nsh-testing/tests/testing/paste/Undo.test.tsx --target linux`

test("a paste the app rewrote is undone in one step", async () => {
  const app = await open("./App.tsx");
  await app.type("id:field", "hello ");
  await app.paste("id:field", { text: "shout:world" });
  await app.waitFor("Paste: rewritten");
  expect(app.value("id:field")).toBe("hello WORLD");
  await app.keyboard.press("ctrl+z");
  await app.wait(100);
  expect(app.value("id:field")).toBe("hello ");
  await app.keyboard.press("ctrl+shift+z");
  await app.wait(100);
  expect(app.value("id:field")).toBe("hello WORLD");
});
