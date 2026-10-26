import { expect, open, test } from "nsh/test";

test("the launch parameters and the host's events reach the app", async () => {
  const app = await open("./App.tsx", { host: { params: { user: "Ada" } } });
  expect(app.shows("Hello, Ada")).toBe(true);
  await app.host.send("message", { text: "hi" });
  expect(app.shows("message hi")).toBe(true);
});

test("without parameters the app reads none", async () => {
  const app = await open("./App.tsx");
  expect(app.shows("Hello, guest")).toBe(true);
});

test("the test's handlers answer the app's calls and hear its posts", async () => {
  const app = await open("./App.tsx", {
    host: {
      handlers: {
        profile: async (data) => ({ name: `Ada ${(data as { id: number }).id}` }),
        fixed: { name: "Grace" },
        failing: () => {
          throw new Error("offline");
        },
        analytics: null,
      },
    },
  });
  await app.press("Ask");
  expect(app.shows("answer Ada 7")).toBe(true);
  await app.press("Ask the fixed");
  expect(app.shows("answer Grace")).toBe(true);
  await app.press("Ask the failing");
  expect(app.shows("failed offline")).toBe(true);
  await app.press("Ask nobody");
  expect(app.texts()).toContain('failed host.call("nobody"): the embedding app handles no "nobody"');
  await app.press("Post");
  expect(app.host.calls()).toEqual([
    { name: "profile", data: { id: 7 } },
    { name: "fixed", data: { id: 7 } },
    { name: "failing", data: { id: 7 } },
  ]);
  expect(app.host.posts()).toEqual([{ name: "analytics", data: { screen: "home" } }]);
});

test("the URLs the app opens are recorded, not opened", async () => {
  const app = await open("./App.tsx");
  expect(app.openedUrls()).toEqual([]);
  await app.press("Open");
  expect(app.shows("opened true")).toBe(true);
  await app.press("text:the guide");
  expect(app.openedUrls()).toEqual(["https://example.com/help", "mailto:guide@example.com"]);
});
