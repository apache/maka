// The Link demo: a site opens outside the app after `onOpen`, the
// navigation routes inside it, a closed page's link is disabled until the
// app opens it, and what the app opened turns visited. URLs are recorded,
// never opened (`app.openedUrls()`).
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("../App.tsx", { clock: {} });
  await app.press("role:button[Link]");
  await app.waitFor("Outside the app");
});

test("a site opens through the system, onOpen first, then onPress", async () => {
  await app.press("role:link[example.com]");
  await app.waitFor("onPress example.com");
  expect(app.openedUrls()).toEqual(["https://example.com/"]);
  const texts = app.texts();
  const opened = texts.indexOf("onOpen https://example.com/ → the system");
  expect(opened).toBeGreaterThan(-1);
  // Newest first: the press is reported after the opening.
  expect(texts.indexOf("onPress example.com")).toBeLessThan(opened);
});

test("the navigation routes inside the app and opens nothing outside it", async () => {
  expect(app.shows("A native shell for AI-generated UI.")).toBe(true);
  // The footer links to the same pages: the navigation comes first.
  await app.press("role:link[Pricing] >> nth=0");
  await app.waitFor("Free while in preview; a seat a month after.");
  await app.waitFor("/pricing");
  await app.press("role:link[Changelog] >> nth=0");
  await app.waitFor("What each release added and fixed.");
  expect(app.openedUrls()).toEqual([]);
});

test("links in a paragraph are pressed in their line and turn visited", async () => {
  await app.waitFor("0 visited");
  await app.press("id:release-notes");
  await app.waitFor("onOpen /docs/release-notes");
  await app.waitFor("1 visited");
  await app.press("role:link[migration guide]");
  await app.waitFor("2 visited");
  // Forgotten: the links go back to the accent.
  await app.press("role:button[Forget visited]");
  await app.waitFor("0 visited");
  expect(app.openedUrls()).toEqual([]);
});

test("a closed page's link takes no press until the app opens it", async () => {
  expect(app.enabled("id:footer-careers")).toBe(false);
  await expect(() => app.press("id:footer-careers")).rejects.toThrow("is disabled");
  expect(app.shows("onOpen /careers")).toBe(false);
  await app.press("label:Hiring");
  await app.waitFor("Careers is open");
  expect(app.enabled("id:footer-careers")).toBe(true);
  await app.press("id:footer-careers");
  await app.waitFor("onOpen /careers");
});

test("resting the pointer on a link shows where it goes, its host whole", async () => {
  // A desktop: the pointer rests on links there.
  const desk = await open("../App.tsx", { platform: "macos", width: 1200, height: 1700, clock: {} });
  await desk.press("role:button[Link]");
  await desk.waitFor("Where it goes");
  await desk.hover("id:where-short");
  await desk.wait(600);
  // One line of two parts: the scheme and host, then the rest. A URL is
  // written with `text:`: its `https:` would be read as a selector prefix.
  await desk.waitFor("text:https://nsh.dev");
  // A Link's title above its URL, in the same bubble.
  await desk.hover("id:where-titled");
  await desk.wait(600);
  await desk.waitFor("text:Link reference");
  expect(desk.shows("text:https://nsh.dev")).toBe(true);
  expect(desk.texts()).toContain("/docs/elements/link");
  // A look-alike host shows as the punycode it is.
  await desk.hover("id:where-idn");
  await desk.wait(600);
  expect(desk.texts().some((t) => t.startsWith("https://xn--") && t.endsWith(".com"))).toBe(true);
  expect(desk.texts()).toContain("/account/sign-in");
  expect(desk.shows("text:Link reference")).toBe(false);
  // A long address keeps its host and its end, its middle cut.
  await desk.hover("id:where-long");
  await desk.wait(600);
  await desk.waitFor("text:https://docs.example.com");
  expect(desk.texts().some((t) => t.startsWith("/guides/") && t.includes("…") && t.endsWith("#verify"))).toBe(true);
  // A Markdown link's title above its URL.
  await desk.hover("the changelog");
  await desk.wait(600);
  await desk.waitFor("What changed in this release");
  expect(desk.shows("text:https://nsh.dev")).toBe(true);
  expect(desk.texts()).toContain("/changelog");
  expect(desk.openedUrls()).toEqual([]);
});
