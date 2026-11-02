// The overlay demos (Overlay, Popover, Tooltip, Sheet) on a phone (headless
// runs are touch screens): the overlay over a clipping box; popovers (a
// share panel with a field and a list, a controlled one its choice
// closes); tooltips the app opens (touch screens show none of their own)
// and a toolbar; sheets (filters applied from a draft, a form, a drawer);
// Escape and back close the top one. Then on a desktop: tooltips follow
// the mouse, after their delays, and the toolbar's keys work. Menus:
// menus.test.tsx; toasts: toasts.test.tsx.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("../App.tsx", { clock: {} });
});

/** Opens the demo of the overlay `name`, once `text` shows. */
async function show(name: string, text: string) {
  await app.press(`role:button[${name}]`);
  await app.waitFor(text);
}

test("an overlay shows outside the box that clips it and closes on a press outside", async () => {
  await show("Overlay", "Open the overlay");
  await app.press("Open the overlay");
  await app.waitFor("Outside the clipped box, on top of the page.");
  await app.waitFor("overlay at bottom");
  // The placement's tabs lie outside it: a press there closes it.
  await app.press("role:tab[Above]");
  expect(app.texts()).not.toContain("Outside the clipped box, on top of the page.");
});

test("the share popover opens from its button, invites, and back closes it", async () => {
  await show("Popover", "Share a document");
  await app.press("Share");
  await app.waitFor("Share “Q3 roadmap”");
  await app.waitFor("share opened · triggerPress");
  await app.type("label:Email to invite", "ana.silva@acme.dev");
  await app.press("Invite");
  await app.waitFor("Ana Silva");
  await app.waitFor("4 people have access");
  await app.waitFor("invited ana.silva@acme.dev");
  // A role changes in place.
  await app.press("label:Ravi Patel: Can view");
  await app.waitFor("label:Ravi Patel: Can edit");
  await app.back();
  await app.waitFor("share closed · cancel");
  await app.waitFor("Share “Q3 roadmap”", { state: "gone" });
});

test("Escape cancels a popover without navigating away", async () => {
  await show("Popover", "Share a document");
  await app.press("Share");
  await app.waitFor("share opened · triggerPress");
  await app.keyboard.press("escape");
  await app.waitFor("share closed · cancel");
  await app.waitFor("Share “Q3 roadmap”", { state: "gone" });
  await app.waitFor("Share a document");
});

test("choosing a reminder closes its popover, and its trigger shows the choice", async () => {
  await show("Popover", "Remind me");
  await app.press("Remind me");
  await app.waitFor("Later today");
  await app.press("Tomorrow");
  await app.waitFor("Tomorrow · Thu 09:00");
  await app.waitFor("reminder Tomorrow · Thu 09:00");
  await app.waitFor("Reminder set for Thu 09:00");
  expect(app.texts()).not.toContain("Later today");
  // Open again: it can be cleared.
  await app.press("Tomorrow · Thu 09:00");
  await app.press("Clear reminder");
  await app.waitFor("Remind me");
  await app.waitFor("reminder cleared");
});

test("a tooltip the app opens shows on a touch screen, which shows none of its own", async () => {
  await show("Tooltip", "Pin the tooltip");
  await app.longPress("Instant");
  expect(app.texts()).not.toContain("Shows at once");
  await app.press("Pin the tooltip");
  await app.waitFor("Shown while pinned or hovered");
  await app.press("Unpin the tooltip");
  await app.waitFor("Pin the tooltip");
  expect(app.texts()).not.toContain("Shown while pinned or hovered");
});

test("the toolbar's tools change, and undo and redo follow them", async () => {
  await show("Tooltip", "Move: Drag to move what is selected");
  await app.press("label:Pen");
  await app.waitFor("Pen: Draw a path, point by point");
  await app.press("label:Undo");
  await app.waitFor("Move: Drag to move what is selected");
  await app.press("label:Redo");
  await app.waitFor("Pen: Draw a path, point by point");
});

test("the filters sheet applies its draft from its footer; closing discards it", async () => {
  await show("Sheet", "128 results");
  await app.press("Filters");
  await app.waitFor("Sort by");
  await app.press("Under $50");
  await app.press("role:switch[In stock]");
  await app.press("Show 36 results");
  await app.waitFor("36 results");
  await app.waitFor("applied Under $50, In stock");
  await app.waitFor("Sort by", { state: "gone" });
  // A change, then back: the draft is dropped.
  await app.press("Filters");
  await app.press("role:switch[On sale]");
  await app.waitFor("Show 9 results");
  await app.back();
  await app.waitFor("filters closed (cancel)");
  await app.waitFor("36 results");
});

test("the form saves only a valid change", async () => {
  await show("Sheet", "Edit profile");
  await app.press("Edit profile");
  await app.waitFor("Bio");
  // Typing adds to what the field holds: clear it first.
  await app.clear("label:Username");
  await app.type("label:Username", "m");
  await app.waitFor("2 to 20 letters, digits, dots or underscores");
  await app.type("label:Username", "ira.c");
  await app.press("Save");
  await app.waitFor("Profile saved");
  await app.waitFor("saved @mira.c");
});

test("a drawer's choice closes it", async () => {
  await show("Sheet", "12 unread");
  await app.press("Inbox");
  await app.waitFor("Mailboxes");
  await app.press("Drafts");
  await app.waitFor("2 unread");
  await app.waitFor("mailbox Drafts");
  await app.waitFor("Mailboxes", { state: "gone" });
});

test("on a desktop, tooltips show while the mouse rests on their element, after their delay", async () => {
  const desk = await open("../App.tsx", { platform: "macos", clock: {} });
  await desk.press("role:button[Tooltip]");
  await desk.waitFor("Default");
  // The usual delay: half a second.
  await desk.hover("Default");
  await desk.wait(300);
  expect(desk.texts()).not.toContain("After half a second");
  await desk.wait(300);
  await desk.waitFor("After half a second");
  // None: at once; leaving hides the other.
  await desk.hover("Instant");
  await desk.waitFor("Shows at once");
  expect(desk.texts()).not.toContain("After half a second");
  // A tool's tooltip names it and its key, which works too.
  await desk.hover("label:Pen");
  await desk.wait(600);
  await desk.waitFor("P");
  await desk.keyboard.press("t");
  await desk.waitFor("Text: Click to add a text box");
  // `Tooltip`, controlled: its delay, its placement, its events.
  await desk.hover("Pin the tooltip");
  await desk.wait(400);
  await desk.waitFor("Shown while pinned or hovered");
  await desk.waitFor("tooltip shown (hover)");
  await desk.hover("Instant");
  await desk.waitFor("tooltip hidden (hover)");
  expect(desk.texts()).not.toContain("Shown while pinned or hovered");
});
