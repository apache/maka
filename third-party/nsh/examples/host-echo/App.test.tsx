// The app with its page's host (nsh.json `web.host`, `host.js`), which
// headless `nsh test` runs as the page would: `nsh test examples/host-echo`.
import { expect, open, test } from "nsh/test";

test("calls reach the page's host and come back", async () => {
  const app = await open("./App.tsx");
  expect(app.shows("text:available: true")).toBe(true);
  await app.press("label:call");
  await app.waitFor('text:{"n":1}');
});

test("events reach host.on, those sent before the app started too", async () => {
  const app = await open("./App.tsx");
  // `createHost` sent one before the app ran, then one a second.
  await app.waitFor("text:ticks: 1");
  await app.waitFor("text:ticks: 2");
});
