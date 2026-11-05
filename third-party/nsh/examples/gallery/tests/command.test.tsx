// The Command demo: a Cmd+K palette in a dialog (recent commands first,
// sections, a disabled command), an inline "Move to" menu with the folder
// in effect checked and a switch for its search field, 5 000 files that
// filter natively with only the rows in view made, and a directory search
// the server answers (`filterable={false}`, `loading`).
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("../App.tsx", { platform: "macos", width: 1200, height: 1700, clock: {} });
  await app.press("role:button[Command]");
  await app.waitFor("role:listbox[Folders]");
});

test("each command is a labelled list box of options", async () => {
  for (const name of ["Folders", "Files", "People"]) expect(app.count(`role:listbox[${name}]`)).toBe(1);
  expect(app.count("role:option[Inbox]")).toBe(1);
  expect(app.enabled("role:option[Spam]")).toBe(false);
});

test("Cmd+K opens the palette; typing filters and Return runs the command", async () => {
  await app.keyboard.press("mod+k");
  await app.waitFor("role:listbox[Commands]");
  expect(app.enabled("role:option[Export Mailbox]")).toBe(false);
  await app.type("text:Type a command or search…", "star");
  await app.waitUntil(() => !app.shows("role:option[Go to Drafts]"));
  expect(app.count("role:listbox[Commands] >> role:option")).toBe(1);
  await app.keyboard.press("enter");
  await app.waitFor("Ran Star Conversation");
  await app.waitUntil(() => !app.shows("role:listbox[Commands]"));
  await app.waitFor("Recent: Star Conversation, New Message, Go to Inbox");
});

test("Escape clears the query, then closes the palette", async () => {
  await app.press("text:Search commands…");
  await app.waitFor("role:listbox[Commands]");
  await app.type("text:Type a command or search…", "zzz");
  await app.waitFor("No commands match");
  await app.keyboard.press("escape");
  await app.waitFor("role:option[Go to Inbox]");
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("role:listbox[Commands]"));
});

test("the arrow keys move the highlight, and a disabled command takes no Return", async () => {
  await app.keyboard.press("mod+k");
  await app.waitFor("role:listbox[Commands]");
  // Go to Inbox under Recent, then the Go to section's three.
  await app.type("text:Type a command or search…", "go to");
  await app.waitUntil(() => app.count("role:listbox[Commands] >> role:option") === 4);
  await app.keyboard.press("down");
  await app.keyboard.press("down");
  await app.keyboard.press("enter");
  await app.waitFor("Ran Go to Drafts");
  // Export Mailbox alone matches: nothing is highlighted, Return runs nothing.
  await app.keyboard.press("mod+k");
  await app.type("text:Type a command or search…", "export");
  await app.waitUntil(() => app.count("role:listbox[Commands] >> role:option") === 1);
  await app.keyboard.press("enter");
  await app.wait(50);
  expect(app.shows("role:listbox[Commands]")).toBe(true);
  await app.waitFor("Ran Go to Drafts");
});

test("a press on a folder moves the conversation there", async () => {
  await app.press("role:option[Receipts]");
  await app.waitFor("Moved to Receipts");
  await app.waitFor("In Receipts");
  expect(app.enabled("role:option[Spam]")).toBe(false);
});

test("5 000 files make only the rows in view and filter natively", async () => {
  expect(app.count("role:listbox[Files] >> role:option")).toBeLessThan(60);
  await app.type("text:Search files by name or extension…", "file-4242");
  await app.waitFor("role:option[module-43/file-4242.tsx]");
  await app.waitFor("1 of 5 000 files");
});

test("the directory search shows the server's answer once it comes", async () => {
  await app.waitFor("Type a name to search the directory");
  await app.type("text:Search people…", "gr");
  await app.waitFor("Searching…");
  await app.clock!.runFor(500);
  await app.waitFor("role:option[Grace Hopper]");
  await app.waitFor("1 found");
});
