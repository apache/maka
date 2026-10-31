import { expect, open, test } from "nsh/test";

test("an action on a selector matching several views says which to pick", async () => {
  const app = await open("./App.tsx");
  expect(app.count("role:button[Delete]")).toBe(2);
  await expect(() => app.press("text:Delete")).rejects.toThrow(/matches 2 pressable views/);
  await app.press("id:row-Eggs >> role:button[Delete]");
  expect(app.texts()).not.toContain("Eggs");
  await app.press("text:Delete >> nth=0");
  expect(app.count("role:button[Delete]")).toBe(0);
});

test("a disabled button takes no press", async () => {
  const app = await open("./App.tsx");
  expect(app.enabled("role:button[Pay]")).toBe(false);
  expect(app.enabled("role:button[Delete] >> nth=0")).toBe(true);
  await expect(() => app.press("Pay")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  expect(app.texts()).toContain("Log: none");
});

test("a long press is held, and no press follows", async () => {
  const app = await open("./App.tsx");
  await app.longPress("Hold me");
  expect(app.texts()).toContain("Log: held");
});

test("clearing an input empties it", async () => {
  const app = await open("./App.tsx");
  await app.clear("id:draft");
  expect(app.value("id:draft")).toBe("");
  await app.type("id:draft", "New");
  expect(app.texts()).toContain("Draft: New");
});

test("waits for what goes away and for a condition", async () => {
  const app = await open("./App.tsx");
  await app.waitFor("Loading…", { state: "gone" });
  await app.type("id:draft", "!");
  await app.waitUntil(() => app.value("id:draft") === "Old text!");
  await expect(() => app.waitUntil(() => false, { timeout: 100 })).rejects.toMatchObject({ code: "ETIMEDOUT" });
});

test("text selectors take a regex", async () => {
  const app = await open("./App.tsx");
  expect(app.count("text:/^(Milk|Eggs)$/")).toBe(2);
  expect(app.shows("text:/^draft:/i")).toBe(true);
});

test("an unknown prefix is an error, and a prefix matches a text with a colon", async () => {
  const app = await open("./App.tsx");
  expect(() => app.shows("log: none")).toThrow(/unknown selector prefix `log:`; known: id, label, role, text, view/);
  await expect(app.press("draft: Old text")).rejects.toThrow(/unknown selector prefix `draft:`/);
  expect(app.shows("text:Log: none")).toBe(true);
  expect(app.shows("Log: none")).toBe(true);
});

test("expectations beyond equality", async () => {
  expect("Saved at 9:41").toMatch(/at \d+:\d+/);
  expect([1, 2, 3]).toHaveLength(3);
  expect(null).toBeNull();
  expect(5).toBeGreaterThan(4);
  expect(5).toBeLessThanOrEqual(5);
  expect(() => JSON.parse("{")).toThrow();
  expect(() => 1).not.toThrow();
});

test("a step's failure has a code to match", async () => {
  const app = await open("./App.tsx");
  // A promise, as Jest takes it, or a function returning one.
  await expect(app.press("Nothing here")).rejects.toMatchObject({
    code: "ERR_NSH_TEST_NOT_FOUND",
    name: "Error",
  });
  await expect(() => app.press("Pay")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  await expect(app.waitFor("Never", { timeout: 50 })).rejects.toMatchObject({ code: "ETIMEDOUT" });
  await expect(app.back()).rejects.toMatchObject({ code: "ERR_NSH_TEST_NO_BACK" });
  await expect(app.press("Pay")).rejects.toThrow(Error);
  await expect(app.press("Pay")).rejects.not.toMatchObject({ code: "ERR_NSH_TEST_NOT_FOUND" });
  // A query throws it.
  let code: unknown = null;
  try {
    app.enabled("Nothing here");
  } catch (e) {
    code = (e as { code?: string }).code;
  }
  expect(code).toBe("ERR_NSH_TEST_NOT_FOUND");
});

test("errors match by class, message and properties", async () => {
  class NotFound extends Error {
    name = "NotFound";
  }
  expect(() => {
    throw new TypeError("not a number");
  }).toThrow(TypeError);
  expect(() => {
    throw new TypeError("not a number");
  }).toThrow(Error);
  expect(() => {
    throw new TypeError("not a number");
  }).not.toThrow(RangeError);
  expect(() => {
    throw new NotFound("gone");
  }).toThrow(NotFound);
  expect(() => {
    throw new Error("exactly this");
  }).toThrow(new Error("exactly this"));
  expect(() => {
    throw new Error("exactly this");
  }).not.toThrow(new Error("exactly"));
  expect(() => {
    throw "a string";
  }).not.toThrow(Error);
  const denied = Object.assign(new Error("not granted"), { code: "ERR_ACCESS_DENIED", permission: "fs" });
  await expect(Promise.reject(denied)).rejects.toMatchObject({
    code: "ERR_ACCESS_DENIED",
    permission: "fs",
    message: "not granted",
  });
  await expect(Promise.reject(denied)).rejects.not.toMatchObject({ code: "ENOENT" });
  await expect(async () => {
    throw denied;
  }).rejects.toThrow(/granted/);
  await expect(Promise.reject({ code: "E_PLAIN" })).rejects.toMatchObject({ code: "E_PLAIN" });
  await expect(Promise.resolve({ ok: true, items: [1, { id: 2, name: "b" }] })).resolves.toMatchObject({
    items: [1, { id: 2 }],
  });
  await expect(Promise.resolve(3)).resolves.toBe(3);
  await expect(Promise.resolve(3)).resolves.not.toBe(4);
  await expect(async () => [1, 2]).resolves.toEqual([1, 2]);
  expect({ a: 1, b: { c: 2, d: 3 } }).toMatchObject({ b: { c: 2 } });
  expect({ a: 1 }).not.toMatchObject({ a: 1, b: 2 });
});
