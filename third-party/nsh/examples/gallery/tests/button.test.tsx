// The Button demo: work that takes a while, a split button and its menu,
// copying, a destructive action held to confirm, and a button disabled
// with its reason.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("../App.tsx", { clock: {} });
  await app.press("label:Button");
  await app.waitFor("Split button");
});

test("a busy button shows its progress, then a check, then its label again", async () => {
  await app.press("label:Save changes");
  await app.waitFor("label:Saving…");
  await app.clock!.runFor(1300);
  await app.waitFor("label:Saved");
  await app.clock!.runFor(2000);
  await app.waitFor("label:Save changes");
});

test("an upload fills its button and ends uploaded", async () => {
  await app.press("id:upload");
  await app.waitFor("text:/^Uploading \\d+%$/");
  await app.clock!.runFor(3000);
  await app.waitFor("Uploaded");
});

test("the split button merges the way its menu chose", async () => {
  await app.press("label:Merge options");
  await app.press("Rebase and merge");
  await app.clock!.runFor(500);
  await app.waitFor("role:button[Rebase and merge]");
  await app.press("role:button[Rebase and merge]");
  await app.waitFor("label:Merging…");
  await app.clock!.runFor(1300);
  await app.waitFor("label:Rebased");
  await app.press("label:Reopen");
  await app.waitFor("role:button[Rebase and merge]");
});

test("copy puts the text on the clipboard and shows a check for a moment", async () => {
  await app.press("label:Copy the command");
  expect(app.clipboard()).toBe("nsh init my-app --template ts");
  await app.waitFor("label:Copied");
  await app.clock!.runFor(1700);
  await app.waitFor("label:Copy the command");
});

test("a short press explains the hold; holding deletes, and Restore brings it back", async () => {
  await app.press("id:hold");
  await app.waitFor("Hold the button for a second to delete.");
  await app.longPress("id:hold");
  await app.waitFor("Deleted");
  await app.waitFor("deleted Q3 roadmap");
  await app.press("label:Restore");
  await app.waitFor("id:hold");
});

test("a disabled button says what to do, and turns on once that is done", async () => {
  expect(app.enabled("label:Publish")).toBe(false);
  await app.waitFor("Add a title first");
  await app.press("label:The post has a title");
  await app.waitFor("Accept the terms to publish");
  await app.press("label:I accept the terms");
  await app.waitFor("Accept the terms to publish", { state: "gone" });
  expect(app.enabled("label:Publish")).toBe(true);
});

test("a favorite toggles, its name following", async () => {
  await app.press("label:Add to favorites");
  await app.waitFor("label:Remove from favorites");
  await app.waitFor("added to favorites");
});
