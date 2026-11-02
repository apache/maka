// The Accordion demo: an FAQ that opens one answer at a time (a disabled
// question takes no press), and settings whose sections open together, with
// switches, radios and a nested accordion in their panels. Triggers are
// buttons inside headings; open panels are regions named after their item.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("../App.tsx", { clock: {} });
  // A tall phone: both cards in view with every section open.
  await app.setViewport(390, 2400);
  await app.press("role:button[Accordion]");
  await app.waitFor("When will my order ship?");
});

test("the FAQ opens one answer at a time and closes the open one", async () => {
  expect(app.texts()).toContain("1 open");
  expect(app.shows("role:region[When will my order ship?]")).toBe(true);
  await app.press("role:button[How do I return an item?]");
  await app.waitFor("FAQ: returns");
  expect(app.shows("role:region[How do I return an item?]")).toBe(true);
  // The answer that was open springs shut, then leaves.
  await app.clock!.runFor(400);
  expect(app.shows("role:region[When will my order ship?]")).toBe(false);
  expect(app.texts()).toContain("Reading: How do I return an item?");
  // Its own trigger closes it.
  await app.press("role:button[How do I return an item?]");
  await app.waitFor("FAQ: all closed");
  await app.clock!.runFor(400);
  expect(app.texts()).toContain("All closed");
  expect(app.shows("role:region[How do I return an item?]")).toBe(false);
  expect(app.shows("role:region[When will my order ship?]")).toBe(false);
});

test("a disabled question takes no press", async () => {
  expect(app.enabled("role:button[Can I add gift wrapping?]")).toBe(false);
  await expect(() => app.press("role:button[Can I add gift wrapping?]")).rejects.toThrow("is disabled");
});

test("settings open several sections together, and their controls work inside", async () => {
  await app.press("role:button[/^Privacy/]");
  await app.waitFor("Settings: notifications, privacy");
  expect(app.shows("role:region[Notifications]")).toBe(true);
  expect(app.shows("role:region[Privacy]")).toBe(true);
  // A switch in the first panel; the heading's summary follows.
  await app.press("role:switch[/^Weekly digest/]");
  await app.waitFor("Weekly digest: on");
  expect(app.texts()).toContain("3 of 3 on");
  // A radio in the second.
  await app.press("role:radio[/^Nobody/]");
  await app.waitFor("Profile visible to: Nobody");
  expect(app.texts()).toContain("Profile visible to nobody");
  // Expand all, then collapse all.
  await app.press("Expand all");
  await app.waitFor("Settings: notifications, privacy, display, advanced");
  await app.press("Collapse all");
  await app.waitFor("Settings: all closed");
});

test("an accordion nested in a panel keeps a value of its own", async () => {
  await app.press("role:button[/^Advanced/]");
  await app.waitFor("Settings: notifications, advanced");
  await app.press("role:button[/^Network/]");
  await app.waitFor("Advanced: network");
  await app.press("role:switch[/^Use cellular data/]");
  await app.waitFor("Use cellular data: off");
  expect(app.texts()).toContain("Wi-Fi only");
  // One nested section at a time: Developer replaces Network.
  await app.press("role:button[/^Developer/]");
  await app.waitFor("Advanced: developer");
  // The outer sections stay as they were.
  expect(app.shows("role:region[Notifications]")).toBe(true);
});
