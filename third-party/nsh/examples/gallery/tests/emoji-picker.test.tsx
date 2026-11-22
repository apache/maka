// The EmojiPicker demo: a composer's emoji button opens the picker over it
// (the groups' tabs, search, the skin tone hand, the emoji under the
// pointer named below); a choice goes into the message and leads the
// recent ones; a tab scrolls to its group; a message's reactions take the
// quick ones and any other from the picker.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("../App.tsx", { platform: "macos", width: 1200, height: 1000, clock: {} });
  await app.press("role:button[EmojiPicker]");
  await app.waitFor("Message composer");
});

test("the composer's button opens the picker; a found emoji goes into the message", async () => {
  await app.press("role:button[Emoji]");
  await app.waitFor("role:listbox[Emoji]");
  expect(app.count("role:tab")).toBe(10);
  expect(app.shows("Frequently used")).toBe(true);
  await app.type("label:Search emoji", "ramen");
  await app.waitFor("role:option[steaming bowl]");
  await app.keyboard.press("enter");
  await app.waitUntil(() => !app.shows("role:listbox[Emoji]"));
  await app.waitFor("Recent: 🍜 👍 😂 ❤️ 🎉 🙏 🔥");
});

test("the pointer names the emoji under it, and the hand sets the skin tone", async () => {
  await app.press("role:button[Emoji]");
  await app.waitFor("role:listbox[Emoji]");
  await app.hover("role:option[upside-down face]");
  await app.waitFor("Upside-down face");
  // The hand lays out the six tones; one takes it.
  await app.press("role:button[Default skin tone]");
  await app.press("role:button[Light skin tone]");
  await app.waitUntil(() => app.count("role:button[Dark skin tone]") === 0);
  await app.type("label:Search emoji", "thumbs up");
  await app.waitFor("role:option[thumbs up]");
  await app.keyboard.press("enter");
  // The tone goes into the message; the recent one is its base.
  await app.waitFor("Recent: 👍 😂 ❤️ 🎉 🙏 🔥");
  expect(app.value("label:Message")?.endsWith("👍🏻")).toBe(true);
});

test("a tab scrolls its group to the top", async () => {
  await app.press("role:button[Emoji]");
  await app.waitFor("role:listbox[Emoji]");
  expect(app.count("role:option[red apple]")).toBe(0);
  await app.press("role:tab[Food & drink]");
  await app.waitFor("role:option[red apple]");
});

test("a reaction from the picker joins the message's", async () => {
  await app.press("role:button[More reactions]");
  await app.waitFor("role:listbox[Emoji]");
  await app.type("label:Search emoji", "taco");
  await app.waitFor("role:option[taco]");
  await app.press("role:option[taco]");
  await app.waitFor("role:button[🌮 1]");
  // The quick ones toggle the reader's own.
  await app.press("role:button[React 🎉]");
  await app.waitFor("role:button[🎉 5]");
});
