// The Controls demo: `nsh/base`'s switches in a settings list (one that
// needs another on), checkboxes under a "select all" that shows a partial
// selection, a plan picker of radios with a disabled plan, tabs that switch
// a section, collapsible sections whose content is kept while collapsed,
// progress bars of a transfer the app drives and of one of unknown size,
// sliders of a level and of a price range.
// Every row is the control, its label included. Also the
// gallery's own `Toggle` (a `Switch`) and `Segmented` (`Tabs`).
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("../App.tsx", { clock: {} });
  await app.press("role:button[Controls]");
  await app.waitFor("Select all");
});

test("a switch turns a setting on and off, and one that needs it is disabled while it is off", async () => {
  expect(app.count("role:switch")).toBe(4);
  await app.press("Notifications");
  await app.waitFor("Notifications: off");
  expect(app.texts()).toContain("Turn on notifications first");
  expect(app.enabled("Badges")).toBe(false);
  await expect(() => app.press("Badges")).rejects.toThrow("is disabled");
  // The track is pressable too, not only the label.
  await app.press("role:switch[/^Notifications/]");
  await app.waitFor("Notifications: on");
  expect(app.enabled("Badges")).toBe(true);
  await app.press("Badges");
  await app.waitFor("Badges: off");
  await app.press("Low data mode");
  await app.waitFor("Images load at a lower quality");
});

test("select all checks every item, from a partial selection, and unchecks them all", async () => {
  expect(app.count("role:checkbox")).toBe(5);
  expect(app.texts()).toContain("3 of 4");
  expect(app.texts()).toContain("Showing 1,338 items");
  // Indeterminate asks for checked.
  await app.press("Select all");
  await app.waitFor("Select all: true");
  expect(app.texts()).toContain("4 of 4");
  expect(app.texts()).toContain("Showing 1,650 items");
  await app.press("Select all");
  await app.waitFor("Select all: false");
  expect(app.texts()).toContain("0 of 4");
  expect(app.texts()).toContain("Nothing to show");
  // One item: a partial selection again.
  await app.press("Videos");
  await app.waitFor("Videos: true");
  expect(app.texts()).toContain("1 of 4");
  expect(app.texts()).toContain("Showing 86 items");
  await app.press("Videos");
  await app.waitFor("Videos: false");
  expect(app.texts()).toContain("Nothing to show");
});

test("a radio picks one plan of the set, and a disabled plan takes no press", async () => {
  expect(app.count("role:radio")).toBe(4);
  expect(app.texts()).toContain("Continue with Plus");
  await app.press("Team");
  await app.waitFor("Plan: Team");
  expect(app.texts()).toContain("Continue with Team");
  await expect(() => app.press("Enterprise")).rejects.toThrow("is disabled");
  await app.press("Continue with Team");
  await app.waitFor("Continue: Team, $12 / mo");
  // A checked radio stays checked and reports nothing.
  await app.press("Team");
  expect(app.texts()).toContain("Continue: Team, $12 / mo");
  await app.press("Free");
  await app.waitFor("Continue with Free");
});

test("tabs show the section the app selects, and a disabled tab takes no press", async () => {
  expect(app.count("role:tab")).toBe(4);
  expect(app.texts()).toContain("Visitors");
  await app.press("Activity");
  await app.waitFor("Tab: Activity");
  expect(app.texts()).toContain("Deployed to production");
  expect(app.texts()).not.toContain("Visitors");
  await expect(() => app.press("Billing")).rejects.toThrow("is disabled");
  await app.press("role:tab[Members]");
  await app.waitFor("Grace Hopper");
  // The selected tab reports its presses too.
  await app.press("Overview");
  await app.waitFor("Tab: Overview");
  await app.press("Overview");
  expect(app.texts()).toContain("Visitors");
});

test("a collapsible shows its content while the app has it open, and keeps it while collapsed", async () => {
  // Both start collapsed.
  expect(app.texts()).not.toContain("Apps");
  expect(app.texts()).not.toContain("Keep originals");
  await app.press("role:button[/^Storage/]");
  await app.waitFor("Storage: expanded");
  expect(app.texts()).toContain("Apps");
  expect(app.texts()).toContain("54 GB");
  await app.press("role:button[/^Storage/]");
  await app.waitFor("Storage: collapsed");
  expect(app.texts()).not.toContain("Apps");
  // What is inside keeps its state from one opening to the next.
  await app.press("role:button[/^Advanced/]");
  await app.waitFor("Advanced: expanded");
  await app.press("Keep originals");
  await app.waitFor("Keep originals: on");
  await app.press("role:button[/^Advanced/]");
  await app.waitFor("Advanced: collapsed");
  expect(app.texts()).not.toContain("Keep originals");
  await app.press("role:button[/^Advanced/]");
  await app.waitFor("Advanced: expanded");
  expect(app.texts()).toContain("Edits are saved as copies");
});

test("a progress bar shows the transfer's value the app drives, and one of unknown size has none", async () => {
  expect(app.count("role:progressbar")).toBe(2);
  expect(app.texts()).toContain("0%");
  expect(app.texts()).toContain("—");
  expect(app.enabled("Reset")).toBe(false);
  await app.press("Send");
  await app.waitFor("Upload: started");
  await app.wait(900);
  expect(app.texts()).toContain("30%");
  await app.press("Pause");
  await app.waitFor("Upload: paused");
  await app.press("Send");
  await app.wait(3000);
  await app.waitFor("Upload: done");
  expect(app.texts()).toContain("100%");
  expect(app.texts()).toContain("24 photos sent");
  await app.press("Reset");
  await app.waitFor("Upload: reset");
  expect(app.texts()).toContain("0%");
});

test("a slider reports the value the app owns, a range's thumbs never cross, and a disabled one takes no drag", async () => {
  expect(app.count("role:adjustable")).toBe(3);
  expect(app.texts()).toContain("60%");
  expect(app.texts()).toContain("$100 – $400");
  // Far past the end: held at the maximum, the end reported once.
  await app.drag("label:Volume", { x: 600, y: 0 });
  await app.waitFor("Volume: 100");
  expect(app.texts()).toContain("100%");
  // The range's start stops at its end.
  await app.drag("label:Minimum price", { x: 600, y: 0 });
  await app.waitFor("Price: 400 to 400");
  expect(app.texts()).toContain("$400 – $400");
  // Muted: the volume's slider is disabled.
  await app.press("Mute");
  await app.waitFor("Volume: muted");
  expect(app.enabled("label:Volume")).toBe(false);
  await app.drag("label:Volume", { x: -600, y: 0 });
  expect(app.texts()).toContain("Volume: muted");
  await app.press("Unmute");
  await app.waitFor("Volume: unmuted");
  expect(app.texts()).toContain("100%");
});

test("the gallery's segmented control is a tab list", async () => {
  await app.back();
  await app.press("role:button[System]");
  await app.waitFor("Status bar");
  expect(app.texts()).toContain('foreground: "dark"');
  await app.press("role:tab[Light]");
  await app.waitFor('foreground: "light"');
  await app.press("role:tab[Auto]");
  await app.waitFor('foreground: "auto"');
});

test("the gallery's toggle is a switch", async () => {
  await app.back();
  await app.press("role:button[Styles]");
  await app.waitFor("Clipping and layers");
  expect(app.texts()).toContain("overflow: hidden");
  await app.press("role:switch[Clip]");
  await app.waitFor("overflow: visible");
  await app.press("label:Clip");
  await app.waitFor("overflow: hidden");
});
