// fetch() against what the test's routes answer: no request reaches the network.
import { expect, open, test } from "nsh/test";

const URL = "https://jsonplaceholder.typicode.com/posts?_limit=3";
const POSTS = `GET ${URL}`;

test("loads the posts the server answers with", async () => {
  const app = await open("../App.tsx", {
    clock: {},
    network: { [POSTS]: { body: [{ id: 1, title: "Hello from the test" }] } },
  });
  await app.press("role:button[System]");
  await app.press("role:button[fetch()]");
  await app.waitFor("loading…", { state: "gone" });
  await app.waitFor("Hello from the test");
  expect(app.texts()).toContain("#1");
});

test("shows why the request failed", async () => {
  const app = await open("../App.tsx", { clock: {}, network: { [POSTS]: { error: "offline" } } });
  await app.press("role:button[System]");
  await app.press("role:button[fetch()]");
  await app.waitFor("text:/offline/");
});

test("asks the server again on each press", async () => {
  // A function answers each request as it comes.
  let asked = 0;
  const app = await open("../App.tsx", {
    clock: {},
    network: { [POSTS]: () => ({ body: [{ id: ++asked, title: `Answer ${asked}` }] }) },
  });
  await app.press("role:button[System]");
  await app.press("role:button[fetch()]");
  await app.waitFor("Answer 1");
  await app.press("role:button[fetch()]");
  await app.waitFor("Answer 2");
  expect(app.requests().map((r) => r.url)).toEqual([URL, URL]);
});

test("reads the files the app ships", async () => {
  // Its bytes with their type, at its `asset:/` URL; one it does not ship
  // rejects as a network error.
  const app = await open("./fixtures/assets.tsx");
  await app.waitFor("File: 200 image/png PNG true");
  await app.waitFor("Missing: TypeError");
});
