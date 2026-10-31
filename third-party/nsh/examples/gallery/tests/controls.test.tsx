// The control demos, one per control: `nsh/base`'s switches in a settings list (one that
// needs another on) and quick-setting tiles, checkboxes under a "select all"
// that shows a partial selection, in a checklist, as choice cards and in
// sizes and disabled states, a plan picker of radios with a disabled plan,
// delivery cards and sized rings, tabs that switch a section and underlined
// ones with counts, collapsible sections whose content is kept while
// collapsed and an accordion, progress bars of a transfer the app drives, of
// one of unknown size and of several uploads, sliders of a level and of a
// price range, number inputs of seats and a price, of a cart's quantities
// and of units in their wells, a one-time code typed or pasted into its
// cells, a sign-in code sent with a countdown to resend it, and a PIN entered
// twice.
// Every row is the control, its label included; on a desktop the plans
// and the tabs are one stop of Tab each, moved through with the arrow
// keys. Also the
// gallery's own `Toggle` (a `Switch`) and `Segmented` (`Tabs`).
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("../App.tsx", { clock: {} });
});

/** Opens the demo of the control `name`, once `text` shows. */
async function show(name: string, text: string) {
  await app.press(`role:button[${name}]`);
  await app.waitFor(text);
}

test("a switch turns a setting on and off, and one that needs it is disabled while it is off", async () => {
  await show("Switch", "Notifications");
  expect(app.count("role:switch")).toBe(9);
  await app.press("Notifications");
  await app.waitFor("Notifications: off");
  expect(app.texts()).toContain("Turn on notifications first");
  expect(app.enabled("Badges")).toBe(false);
  expect(app.enabled("Previews")).toBe(false);
  await expect(() => app.press("Badges")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  // The track is pressable too, not only the label.
  await app.press("role:switch[/^Notifications/]");
  await app.waitFor("Notifications: on");
  expect(app.enabled("Badges")).toBe(true);
  await app.press("Badges");
  await app.waitFor("Badges: off");
  await app.press("Low data mode");
  await app.waitFor("Images load at a lower quality");
});

test("a quick setting is a tile with a switch, and Focus silences the sounds", async () => {
  await show("Switch", "Quick settings");
  expect(app.enabled("Sounds")).toBe(true);
  await app.press("Focus");
  await app.waitFor("Focus: on");
  expect(app.texts()).toContain("Silenced by Focus");
  expect(app.enabled("Sounds")).toBe(false);
  await app.press("role:switch[/^Focus/]");
  await app.waitFor("Focus: off");
  await app.press("Sounds");
  await app.waitFor("Sounds: on");
});

test("select all checks every item, from a partial selection, and unchecks them all", async () => {
  await show("Checkbox", "Select all");
  expect(app.count("role:checkbox")).toBe(23);
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

test("a checklist counts the tasks done, choice cards and disabled boxes take no press", async () => {
  await show("Checkbox", "Checklist");
  expect(app.texts()).toContain("2 of 5");
  for (const task of ["Record the compatibility baseline", "Tag the release", "Announce it"]) {
    await app.press(task);
    await app.waitFor(`${task}: done`);
  }
  expect(app.texts()).toContain("5 of 5");
  expect(app.texts()).toContain("Ready to ship");
  await app.press("Email");
  await app.waitFor("Email: true");
  expect(app.texts()).toContain("Notifying you by push and email");
  await expect(() => app.press("SMS")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  await expect(() => app.press("Required")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  await app.press("Large");
  await app.waitFor("Large: true");
});

test("consent choices: the necessary one is always on, accept all checks the rest", async () => {
  await show("Checkbox", "Consent");
  await expect(() => app.press("Necessary (always on)")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  await app.press("Accept all");
  await app.waitFor("Consent: all accepted");
  await app.press("Save choices");
  await app.waitFor("Consent: Analytics, Personalization, Marketing");
  expect(app.enabled("Saved")).toBe(false);
  await app.press("Marketing");
  await app.waitFor("Marketing: false");
  expect(app.enabled("Save choices")).toBe(true);
});

test("a radio picks one plan of the set, and a disabled plan takes no press", async () => {
  await show("Radio", "Free");
  expect(app.count("role:radio")).toBe(11);
  expect(app.texts()).toContain("Continue with Plus");
  await app.press("Team");
  await app.waitFor("Plan: Team");
  expect(app.texts()).toContain("Continue with Team");
  await expect(() => app.press("Enterprise")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  await app.press("Continue with Team");
  await app.waitFor("Continue: Team, $12 / mo");
  // A checked radio stays checked and reports nothing.
  await app.press("Team");
  expect(app.texts()).toContain("Continue: Team, $12 / mo");
  await app.press("Free");
  await app.waitFor("Continue with Free");
});

test("choice cards and sized rings pick one each, a locked one takes no press", async () => {
  await show("Radio", "Choice cards");
  await app.press("Express");
  await app.waitFor("Delivery: Express");
  await expect(() => app.press("Same day")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  await app.press("Large");
  await app.waitFor("Text size: Large");
  await expect(() => app.press("Huge")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
});

test("tabs show the section the app selects, and a disabled tab takes no press", async () => {
  await show("Tabs", "Overview");
  expect(app.count("role:tab")).toBe(8);
  expect(app.texts()).toContain("Visitors");
  await app.press("Activity");
  await app.waitFor("Tab: Activity");
  expect(app.texts()).toContain("Deployed to production");
  expect(app.texts()).not.toContain("Visitors");
  await expect(() => app.press("Billing")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  await app.press("role:tab[Members]");
  await app.waitFor("Grace Hopper");
  // The selected tab reports its presses too.
  await app.press("Overview");
  await app.waitFor("Tab: Overview");
  await app.press("Overview");
  expect(app.texts()).toContain("Visitors");
});

test("underlined tabs show their own content, with counts", async () => {
  await show("Tabs", "Underlined");
  expect(app.texts()).toContain("Support right-to-left menus");
  await app.press("Pull requests");
  await app.waitFor("Project: Pull requests");
  expect(app.texts()).toContain("Read fonts from the bundle");
  expect(app.texts()).not.toContain("Support right-to-left menus");
  await expect(() => app.press("Wiki")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
});

test("a collapsible shows its content while the app has it open, and keeps it while collapsed", async () => {
  await show("Collapsible", "Advanced");
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

test("an accordion keeps one answer open at a time", async () => {
  await show("Collapsible", "Accordion");
  const first = "Yes. A new plan starts at once, and what is left of the old one is credited to your next invoice.";
  expect(app.texts()).toContain(first);
  await app.press("role:button[/^What happens/]");
  await app.waitFor("What happens to my photos if I cancel?: expanded");
  expect(app.texts()).not.toContain(first);
  await app.press("role:button[/^What happens/]");
  await app.waitFor("What happens to my photos if I cancel?: collapsed");
});

test("a progress bar shows the transfer's value the app drives, and one of unknown size has none", async () => {
  await show("Progress", "Upload");
  expect(app.count("role:progressbar")).toBe(9);
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

test("several uploads run at their own pace until all are sent", async () => {
  await show("Progress", "Several files");
  expect(app.texts()).toContain("0 of 3");
  await app.press("Upload all");
  await app.waitFor("Uploads: started");
  expect(app.enabled("Uploading…")).toBe(false);
  await app.wait(5400);
  await app.waitFor("Uploads: done");
  expect(app.texts()).toContain("3 of 3");
  expect(app.texts()).toContain("Upload again");
});

test("a stepped setup moves its bar a step at a time until it is done", async () => {
  await show("Progress", "Steps");
  expect(app.texts()).toContain("Step 2 of 4");
  await app.press("Previous step");
  await app.waitFor("Setup: Account");
  expect(app.enabled("Previous step")).toBe(false);
  for (const name of ["Profile", "Team", "Review"]) {
    await app.press("Next step");
    await app.waitFor(`Setup: ${name}`);
  }
  await app.press("Finish");
  await app.waitFor("Setup: done");
  expect(app.texts()).toContain("Done");
  await app.press("Start over");
  await app.waitFor("Setup: Account");
});

test("a slider reports the value the app owns, a range's thumbs never cross, and a disabled one takes no drag", async () => {
  await show("Slider", "Volume");
  expect(app.count("role:adjustable")).toBe(8);
  expect(app.texts()).toContain("60%");
  expect(app.texts()).toContain("$100 – $400");
  expect(app.texts()).toContain("241 listings between the two");
  // Far past the end: held at the maximum, the end reported once.
  await app.drag("label:Volume", { x: 600, y: 0 });
  await app.waitFor("Volume: 100");
  expect(app.texts()).toContain("100%");
  // The range's start stops at its end.
  await app.drag("label:Minimum price", { x: 600, y: 0 });
  await app.waitFor("Price: 400 to 400");
  expect(app.texts()).toContain("$400 – $400");
  expect(app.texts()).toContain("5 listings between the two");
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

test("an equalizer's presets set its vertical bands", async () => {
  await show("Slider", "Vertical");
  await app.press("role:tab[Bass]");
  await app.waitFor("Equalizer: Bass");
  expect(app.texts()).toContain("+8");
  await app.press("role:tab[Flat]");
  await app.waitFor("Equalizer: Flat");
  expect(app.texts()).not.toContain("+8");
});

test("a number input steps with the keys, holds a typed number to its range, and a locked one takes neither", async () => {
  await show("NumberInput", "Seats");
  expect(app.count("role:spinbutton")).toBe(9);
  await app.type("label:Seats", "");
  await app.keyboard.press("up");
  await app.waitFor("Seats: 3");
  // Typed past the maximum: reported as typed, then held to it when the
  // field is left for the price's (a phone's Tab moves nothing).
  await app.type("label:Seats", "0");
  await app.waitFor("Seats: 30");
  await app.type("label:Price", "");
  await app.waitFor("Seats: 8");
  // A page down is ten steps, stopped at the minimum.
  await app.type("label:Seats", "");
  await app.keyboard.press("pagedown");
  await app.waitFor("Seats: 1");
  await app.type("label:Price", "");
  await app.keyboard.press("down");
  await app.waitFor("Price: 24");
  // Locked: the seats' field takes nothing.
  await app.press("Lock seats");
  await app.waitFor("Seats: locked");
  expect(app.enabled("label:Seats")).toBe(false);
  await app.press("Unlock seats");
  await app.waitFor("Seats: unlocked");
  expect(app.enabled("label:Seats")).toBe(true);
});

test("a one-time code takes digits up to its length, and a pasted code fills it", async () => {
  await show("OtpInput", "The code is 246810");
  const code = "label:Verification code, 6 digits";
  expect(app.texts()).toContain("The code is 246810");
  expect(app.enabled("Clear")).toBe(false);
  // Digits only, one cell each.
  await app.type(code, "13a5");
  await app.waitFor("Code: 135");
  expect(app.texts()).toContain("5");
  expect(app.texts()).not.toContain("a");
  await app.press("Clear");
  await app.waitFor("Code: cleared");
  // A pasted code replaces the code; the app checks it once it is full.
  await app.paste(code, { text: "246 810" });
  await app.waitFor("Code complete: 246810");
  expect(app.texts()).toContain("Verified");
  // Full: another digit changes nothing.
  await app.type(code, "9");
  await app.wait(50);
  expect(app.texts()).toContain("Code complete: 246810");
  expect(app.texts()).not.toContain("9");
});

test("a cart's quantities hold to the stock and roll the totals, and units sit in their wells", async () => {
  await show("NumberInput", "Linen shirt");
  expect(app.texts()).toContain("$134.00");
  expect(app.texts()).toContain("Add $16.00 more for free shipping");
  await app.type("label:Quantity of Canvas tote", "");
  await app.keyboard.press("up");
  await app.waitFor("Canvas tote: 3");
  await app.waitFor("Only 3 left");
  // 48 + 3 × 22 + 3 × 14: past the free shipping.
  await app.waitFor("Free shipping unlocked");
  expect(app.texts()).toContain("$156.00");
  // Typed past the balance (still within the input's range): the transfer says so.
  await app.type("label:Transfer amount", "0");
  await app.waitFor("Transfer: 2500");
  await app.waitFor("More than your balance of $1,200.00");
  await app.type("label:Thermostat", "");
  await app.keyboard.press("up");
  await app.waitFor("Thermostat: 22");
  await app.type("label:Tip", "");
  await app.keyboard.press("up");
  await app.waitFor("Tip: 20%");
  await app.waitFor("$16.80");
});

test("a sign-in code is sent, counts down to a resend, shakes off a wrong code and signs in", async () => {
  await show("OtpInput", "We will text a code to +1 555 010 2299");
  const code = "label:Sign-in code, 6 digits";
  expect(app.enabled(code)).toBe(false);
  await app.press("role:button[Send code]");
  await app.waitFor("Resend code in");
  expect(app.texts()).toContain("0:30");
  await app.wait(1000);
  await app.waitFor("0:29");
  // A wrong code: checked a moment later, then emptied, with two tries left.
  await app.type(code, "111111");
  await app.waitFor("Sign-in code: 111111");
  await app.wait(700);
  await app.waitFor("That code is wrong: 2 tries left");
  // Once the countdown ends, a new code can be sent.
  await app.clock!.runFor(30_000);
  await app.waitFor("role:button[Resend code]");
  await app.paste(code, { text: "135 790" });
  await app.waitFor("Sign-in code: 135790");
  await app.wait(700);
  await app.waitFor("Signed in");
  await app.waitFor("Sign-in: verified");
  expect(app.enabled(code)).toBe(false);
});

test("a PIN is entered twice, masked: a mismatch starts over, a match sets it", async () => {
  await show("OtpInput", "Choose a 4-digit PIN");
  const pin = "label:PIN, 4 digits";
  await app.type(pin, "25");
  expect(app.texts()).toContain("•");
  await app.type(pin, "80");
  await app.waitFor("Enter it again");
  await app.type(pin, "2581");
  await app.waitFor("The PINs do not match: choose one again");
  await app.type(pin, "1379");
  await app.waitFor("Enter it again");
  await app.type(pin, "1379");
  await app.waitFor("PIN set");
  expect(app.enabled(pin)).toBe(false);
  await app.press("role:button[Change PIN]");
  await app.waitFor("Choose a 4-digit PIN");
});

test("the gallery's segmented control is a tab list", async () => {
  await app.press("role:button[System]");
  await app.waitFor("Status bar");
  expect(app.texts()).toContain('foreground: "dark"');
  await app.press("role:tab[Light]");
  await app.waitFor('text:foreground: "light"');
  await app.press("role:tab[Auto]");
  await app.waitFor('text:foreground: "auto"');
});

test("the gallery's toggle is a switch", async () => {
  await app.press("role:button[Styles]");
  await app.waitFor("Clipping and layers");
  expect(app.texts()).toContain("overflow: hidden");
  await app.press("role:switch[Clip]");
  await app.waitFor("text:overflow: visible");
  await app.press("label:Clip");
  await app.waitFor("text:overflow: hidden");
});

test("the keyboard moves through the plans and the tabs, each one stop of Tab", async () => {
  // A desktop: Tab stops at the views that take presses. A manual clock:
  // the gallery's live demos never settle, and in a real window each key
  // would wait for them.
  const desk = await open("../App.tsx", { platform: "macos", clock: {} });
  await desk.press("role:button[Radio]");
  await desk.waitFor("Continue with Plus");
  // Tab from stop to stop until the plans, entered at the checked one
  // (Plus): Down there checks the plan after it.
  let tabs = 0;
  while (!desk.shows("Plan: Team")) {
    expect(++tabs).toBeLessThan(40);
    await desk.keyboard.press("tab");
    await desk.keyboard.press("down");
    await desk.wait(50);
  }
  // Enterprise is disabled: Down goes around to Free, Up back to Team.
  await desk.keyboard.press("down");
  await desk.waitFor("Plan: Free");
  await desk.keyboard.press("up");
  await desk.waitFor("Plan: Team");
  await desk.keyboard.press("right");
  await desk.waitFor("Plan: Free");
  await desk.keyboard.press("left");
  await desk.waitFor("Plan: Team");
  // One Tab leaves the group: Return presses the button after it.
  await desk.keyboard.press("tab");
  await desk.keyboard.press("enter");
  await desk.waitFor("Continue: Team, $12 / mo");
  // On to the tabs, entered at the selected one (Overview): the arrows
  // select as they move.
  await desk.back();
  await desk.press("role:button[Tabs]");
  await desk.waitFor("Visitors");
  tabs = 0;
  while (!desk.shows("Tab: Activity")) {
    expect(++tabs).toBeLessThan(10);
    await desk.keyboard.press("tab");
    await desk.keyboard.press("right");
    await desk.wait(50);
  }
  expect(desk.texts()).toContain("Deployed to production");
  // Billing is disabled: End stops at Members, Right goes around.
  await desk.keyboard.press("end");
  await desk.waitFor("Tab: Members");
  await desk.waitFor("Grace Hopper");
  await desk.keyboard.press("right");
  await desk.waitFor("Tab: Overview");
  expect(desk.texts()).toContain("Visitors");
  await desk.keyboard.press("left");
  await desk.waitFor("Tab: Members");
  await desk.keyboard.press("home");
  await desk.waitFor("Tab: Overview");
});
