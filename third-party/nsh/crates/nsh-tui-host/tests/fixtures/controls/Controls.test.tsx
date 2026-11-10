import { expect, open, test } from "nsh/test";

test("the official Controls demo is operable with the terminal key scheme", async () => {
  // A single column keeps the demo's reading order, in an ordinary 100 by 40 Cell terminal.
  const app = await open("./App.tsx", { width: 800, height: 640, clock: {} });
  await app.waitFor("Select all");
  await app.keyboard.press("tab");
  await app.keyboard.press("enter");
  await app.waitFor("Notifications: off");
  expect(app.enabled("Badges")).toBe(false);
  await app.keyboard.press("ctrl+n");
  await app.keyboard.press("enter");
  await app.waitFor("Haptics: on");
  await app.keyboard.press("down");
  await app.keyboard.press("enter");
  await app.waitFor("Images load at a lower quality");
  await app.keyboard.press("tab");
  await app.keyboard.press("enter");
  await app.waitFor("Select all: true");
  expect(app.texts()).toContain("4 of 4");
  await app.keyboard.press("enter");
  await app.waitFor("Nothing to show");

  // Four filter items, then the first radio. Enterprise remains outside the focus order.
  for (let i = 0; i < 5; i++) await app.keyboard.press("tab");
  // The group's stop is its checked radio (Plus): up moves to Free.
  await app.keyboard.press("up");
  await app.keyboard.press("enter");
  await app.waitFor("Plan: Free");
  await app.keyboard.press("down");
  await app.keyboard.press("enter");
  await app.waitFor("Plan: Plus");
  await app.keyboard.press("down");
  await app.keyboard.press("enter");
  await app.waitFor("Plan: Team");
  await app.keyboard.press("tab");
  await app.keyboard.press("enter");
  await app.waitFor("Continue: Team, $12 / mo");

  await app.keyboard.press("tab");
  await app.keyboard.press("right");
  await app.keyboard.press("enter");
  await app.waitFor("Deployed to production");
  await app.keyboard.press("ctrl+f");
  await app.keyboard.press("enter");
  await app.waitFor("Grace Hopper");
  await app.keyboard.press("ctrl+b");
  await app.keyboard.press("enter");
  await app.waitFor("Tab: Activity");
  await app.keyboard.press("right");
  await app.keyboard.press("tab");
  await app.keyboard.press("enter");
  await app.waitFor("Storage: expanded");
  expect(app.texts()).toContain("54 GB");
  await app.keyboard.press("enter");
  await app.waitFor("Storage: collapsed");
  expect(app.texts()).not.toContain("Apps");
  await app.keyboard.press("tab");
  await app.keyboard.press("enter");
  await app.waitFor("Advanced: expanded");
  await app.keyboard.press("tab");
  await app.keyboard.press("enter");
  await app.waitFor("Keep originals: on");
  await app.keyboard.press("shift+tab");
  await app.keyboard.press("enter");
  await app.waitFor("Advanced: collapsed");
  await app.keyboard.press("enter");
  await app.waitFor("Edits are saved as copies");
  await app.keyboard.press("enter");
  await app.waitFor("Advanced: collapsed");

  await app.keyboard.press("tab");
  await app.keyboard.press("enter");
  await app.waitFor("Upload: started");
  await app.wait(900);
  expect(app.texts()).toContain("30%");
  await app.keyboard.press("enter");
  await app.waitFor("Upload: paused");
  expect(app.count("role:progressbar")).toBe(2);
  await app.keyboard.press("tab"); // Reset
  await app.keyboard.press("tab"); // Volume thumb
  await app.keyboard.press("right");
  await app.waitFor("Volume: 65");
  await app.keyboard.press("pageup");
  await app.waitFor("Volume: 75");
  await app.keyboard.press("home");
  await app.waitFor("Volume: 0");
  await app.keyboard.press("end");
  await app.waitFor("Volume: 100");
  await app.keyboard.press("tab");
  await app.keyboard.press("end");
  await app.waitFor("Price: 400 to 400");
  await app.keyboard.press("tab");
  await app.keyboard.press("end");
  await app.waitFor("Price: 400 to 500");
  await app.keyboard.press("home");
  await app.waitFor("Price: 400 to 400");
  await app.keyboard.press("tab");
  await app.keyboard.press("enter");
  await app.waitFor("Volume: muted");
  expect(app.enabled("label:Volume")).toBe(false);
  await app.keyboard.press("enter");
  await app.waitFor("Volume: unmuted");
  const picture = JSON.parse(new TextDecoder().decode(new Uint8Array(await app.screenshot())));
  expect(picture.format).toBe("nsh-tui-cells");
  expect(picture.rows.some((row: { symbol: string }[]) => row.map(cell => cell.symbol).join("").includes("100%"))).toBe(true);
}, 180_000);

test("the official controls take mouse presses and preserve disabled and collapsed behavior", async () => {
  const app = await open("./App.tsx", { width: 800, height: 640, clock: {} });
  await app.press("Notifications");
  await app.waitFor("Notifications: off");
  await expect(() => app.press("Badges")).rejects.toThrow("is disabled");
  await app.press("Select all");
  await app.waitFor("Select all: true");
  await app.press("Videos");
  await app.waitFor("Videos: false");
  await app.press("Team");
  await app.waitFor("Plan: Team");
  await expect(() => app.press("Enterprise")).rejects.toThrow("is disabled");
  await app.press("Continue with Team");
  await app.waitFor("Continue: Team, $12 / mo");
  await app.press("role:tab[Activity]");
  await app.waitFor("Deployed to production");
  await expect(() => app.press("Billing")).rejects.toThrow("is disabled");
  await app.press("role:button[/^Advanced/]");
  await app.waitFor("Advanced: expanded");
  await app.press("Keep originals");
  await app.waitFor("Keep originals: on");
  await app.press("role:button[/^Advanced/]");
  await app.waitFor("Advanced: collapsed");
  expect(app.texts()).not.toContain("Keep originals");
  await app.press("role:button[/^Advanced/]");
  await app.waitFor("Edits are saved as copies");
  await app.press("Send");
  await app.wait(3000);
  await app.waitFor("Upload: done");
  await app.press("Reset");
  await app.waitFor("Upload: reset");
  expect(app.texts()).toContain("0%");
}, 180_000);

test("the official Volume slider follows a mouse drag to both ends", async () => {
  const app = await open("./App.tsx", { width: 800, height: 640, clock: {} });
  await app.waitFor("Select all");
  // The drag starts on the slider's middle and goes past its start: the value is the track's first Cell.
  await app.drag("label:Volume", { x: -2000, y: 0 });
  await app.waitFor("Volume: 0");
  // Past its end: the last Cell, the largest value.
  await app.drag("label:Volume", { x: 2000, y: 0 });
  await app.waitFor("Volume: 100");
});
