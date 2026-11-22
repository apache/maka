import { expect, open, test } from "nsh/test";

test("adds a todo", async () => {
  const app = await open("./App.tsx", {
    storage: { todos: JSON.stringify(["Walk"]) },
    network: { "GET https://api.test/quote": { body: { text: "Hi" } } },
  });
  await app.waitFor("Hi");
  expect(app.texts()).toContain("1 left");
  await app.type("text:What to do?", "Buy milk");
  expect(app.value("id:new-todo")).toBe("Buy milk");
  await app.press("Add");
  await app.waitFor("Buy milk");
  expect(app.texts()).toContain("2 left");
  expect(app.storage().todos).toBe(JSON.stringify(["Walk", "Buy milk"]));
  expect(app.value("id:new-todo")).toBe("");
  await app.type("id:new-todo", "Read\n");
  await app.waitFor("3 left");
});

test("is offline without the network", async () => {
  const app = await open("./App.tsx");
  await app.waitFor("offline");
  expect(app.texts()).not.toContain("Hi");
});

test("fails with what is on screen", async () => {
  const app = await open("./App.tsx");
  await app.waitFor("0 left");
  expect(app.texts()).toContain("Nope");
});
