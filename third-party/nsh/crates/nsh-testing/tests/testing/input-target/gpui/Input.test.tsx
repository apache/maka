import { expect, open, test } from "nsh/test";

test("typing a long line completes in one host step", async () => {
  const app = await open("./Input.tsx", { platform: "macos" });
  const text = "abcd".repeat(2560);
  await app.type("field", text);
  expect(app.value("field")).toBe(text);
}, 60000);

test("an unacknowledged edit stops the rest of the type step", async () => {
  const app = await open("./Input.tsx", { platform: "macos" });
  await expect(() => app.type("field", "!b\nc")).rejects.toThrow("timed out waiting for a keyboard edit");
  await app.waitFor("Handler finished");
  expect(app.value("field")).toBe("!");
  expect(app.shows("Submits: 0")).toBe(true);
}, 30000);

test("a press in a scrolled single-line input places the caret in the visible text", async () => {
  const app = await open("./Input.tsx", { platform: "macos", width: 140 });
  const line = "W".repeat(120);
  await app.type("field", line);
  // A zero-distance drag sends pointer down and up at the center of the field.
  await app.drag("field", { x: 0, y: 0 });
  await app.type("field", "x");
  const value = app.value("field") ?? "";
  expect(value.replace("x", "")).toBe(line);
  const caret = value.indexOf("x");
  expect(caret > 100 && caret < line.length).toBe(true);
});
