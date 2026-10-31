// The Avatar demo: a team whose presence dots change on a press, a stacked
// group whose overflow counts the members not shown, and pictures that load,
// fail or are missing. Headless runs load no images, so every avatar with a
// picture stays loading and shows its fallback: the initials of its name.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("../App.tsx", { clock: {} });
  await app.press("role:button[Avatar]");
  await app.waitFor("Team");
});

test("an avatar shows the initials of its name until its picture loads", async () => {
  await app.waitFor("AL");
  expect(app.shows("GH")).toBe(true);
  // Without a picture, at once; the one without a name shows the app's glyph.
  expect(app.shows("DK")).toBe(true);
  // The statuses the demo heard: the two without a picture are idle.
  expect(app.count("text:idle")).toBe(2);
});

test("screen readers hear an image named after the person", async () => {
  expect(app.count("role:image[Donald Knuth]")).toBe(1);
  // A picture beside its name is decorative: the thread's are left out.
  expect(app.count("role:image[Grace Hopper]")).toBe(1);
  // No name: the app's label.
  expect(app.count("role:image[Guest]")).toBe(1);
});

test("the stacked group counts the members it does not show", async () => {
  await app.waitFor("+5");
  await app.waitFor("and 5 more");
  await app.press("role:button[Add member]");
  await app.waitFor("+6");
  await app.waitFor("10 members");
  await app.press("text:5 shown");
  await app.waitFor("+5");
  await app.waitFor("Limit: 5");
});

test("a press changes a member's presence", async () => {
  await app.waitFor("2 online");
  await app.press("text:Engineering lead");
  await app.waitFor("Ada Lovelace: away");
  await app.waitFor("1 online");
});
