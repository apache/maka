import { expect, open, test } from "nsh/test";

test("the page's host answers calls", async () => {
  const app = await open("./App.tsx");
  expect(app.shows("text:available: true")).toBe(true);
  await app.press("label:echo");
  await app.waitFor('text:result: {"n":1}');
});

test("a call the host fails rejects with its message", async () => {
  const app = await open("./App.tsx");
  await app.press("label:fail");
  await app.waitFor("text:result: rejected: ERR_NSH_HOST_ERROR boom");
  await app.press("label:big");
  await app.waitFor("text:/result: rejected: .*BigInt/");
});

test("events sent before the app started reach it in order", async () => {
  const app = await open("./App.tsx");
  await app.waitFor("text:ticks: [1,2]");
});

test("each app gets a host of its own", async () => {
  await open("./App.tsx");
  const second = await open("./App.tsx");
  await second.waitFor("text:ticks: [1,2]");
});

test("a function the app does not declare is refused", async () => {
  const app = await open("./App.tsx");
  await app.press("label:other");
  await app.waitFor("text:/result: rejected: ERR_ACCESS_DENIED /");
});

test("a call the host does not answer times out on the app's clock", async () => {
  const app = await open("./App.tsx", { clock: {} });
  await app.press("label:slow");
  await app.clock!.runFor(900);
  expect(app.shows("text:result: (none)")).toBe(true);
  await app.clock!.runFor(200);
  await app.waitFor("text:/result: rejected: ETIMEDOUT /");
});

test("the host's timers run on the app's clock", async () => {
  const app = await open("./App.tsx", { clock: {} });
  await app.press("label:later");
  await app.clock!.runFor(400);
  expect(app.shows("text:result: (none)")).toBe(true);
  await app.clock!.runFor(200);
  await app.waitFor('text:result: "late"');
});
