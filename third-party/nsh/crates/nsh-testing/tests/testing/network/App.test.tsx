import { expect, open, test } from "nsh/test";

test("off the network, sockets and WebSockets are refused", async () => {
  // Routes answer requests; they give no connections.
  const app = await open("./App.tsx", { network: { "GET https://api.test/": { body: "ok" } } });
  await app.waitFor("text:Socket: failed ERR_NSH_TEST_NETWORK");
  await app.waitFor("text:WebSocket: failed ERR_NSH_TEST_NETWORK");
  await app.waitFor("text:Global WebSocket: closed 1006 by the test");
});

test("without routes too", async () => {
  const app = await open("./App.tsx");
  await app.waitFor("text:Socket: failed ERR_NSH_TEST_NETWORK");
  await app.waitFor("text:WebSocket: failed ERR_NSH_TEST_NETWORK");
  await app.waitFor("text:Global WebSocket: closed 1006 by the test");
});

test("on the live network, they reach it", async () => {
  const app = await open("./App.tsx", { network: "live" });
  await app.waitUntil(() => !app.texts().some((t) => t.includes("waiting")), { timeout: 15000 });
  const texts = app.texts();
  expect(texts.some((t) => t.includes("ERR_NSH_TEST_NETWORK"))).toBe(false);
  expect(texts).toContain("Global WebSocket: closed 1006 by the network");
});
