// The embedded app with the host app's part played by the test (`open`'s
// `host`): its launch parameters, a message, the call it answers
// and the links the app opens. The badge is a native component of the host
// app, which a headless run does not draw.
import { expect, open, test } from "nsh/test";

test("the host's parameters and messages reach the app", async () => {
  const app = await open("./App.tsx", { host: { params: { user: "Ada" } } });
  expect(app.shows("Hello, Ada")).toBe(true);
  expect(app.shows("No message from the host yet")).toBe(true);
  await app.host.send("message", { text: "Your order filled" });
  expect(app.shows("Your order filled")).toBe(true);
});

test("the host answers the app's call", async () => {
  const app = await open("./App.tsx", {
    host: { handlers: { time: () => ({ time: "09:30" }) } },
  });
  await app.press("Ask the host for the time");
  expect(app.shows("The host says it is 09:30")).toBe(true);
  expect(app.host.calls()).toEqual([{ name: "time", data: null }]);
});

test("a host that does not answer is reported", async () => {
  const app = await open("./App.tsx");
  await app.press("Ask the host for the time");
  expect(app.shows("The host did not answer: nsh/host: this platform has no host")).toBe(true);
});

test("the documentation link opens outside the app", async () => {
  const app = await open("./App.tsx");
  await app.press("Read the documentation");
  expect(app.openedUrls()).toEqual(["https://github.com/longbridge/nsh"]);
});
