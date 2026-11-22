// The Storage demo and the demo the gallery opens at launch: what one run
// stores, the next reads back (`open`'s `storage` is what the next launch
// finds, `app.storage()` what this one left).
import { expect, open, test } from "nsh/test";

const NOTE = "text:Write something, then come back to it";
const PHOTOS = "A long recycled list: images, pull to refresh, paging";

test("shows the launches, the note and the stored keys, and clears them", async () => {
  const app = await open(".", { clock: {} });
  await app.press("label:Storage");
  for (const text of [
    "Launches",
    "Kept",
    "1 opening",
    'set_item("launches", "1")',
    "Note",
    "0 chars",
    "Stored keys",
    "launches",
    "1 chars",
    // The gallery's own: the demo open.
    "lastDemo",
    "7 chars",
    "2 keys",
    "24 chars of 5 MB",
    "Clear all",
    "The data stays on this device and survives restarts, under the app's id from nsh.json.",
  ]) {
    expect(app.texts()).toContain(text);
  }
  expect(app.shows("Saved")).toBe(false);
  // The note is saved as it is typed, and listed.
  await app.type(NOTE, "Hello");
  for (const text of ["Saved", "5 chars", "note", "3 keys", "33 chars of 5 MB"]) {
    await app.waitFor(text);
  }
  // Emptied: the key goes.
  await app.clear("text:Hello");
  await app.waitFor("note", { state: "gone" });
  await app.type(NOTE, "Hello");
  await app.waitFor("note");
  // Unanswered, the dialog's cancel button keeps everything.
  await app.press("Clear all");
  expect(app.dialogs()[0].title).toBe("Clear the storage?");
  expect(app.texts()).toContain("note");
  // Cleared: nothing is left.
  app.onDialog((dialog) => (dialog.title === "Clear the storage?" ? "Clear" : null));
  await app.press("Clear all");
  for (const text of ["Nothing stored", "0 keys", "0 openings", "0 chars"]) {
    await app.waitFor(text);
  }
  for (const text of ["launches", "note", "lastDemo", "Saved"]) {
    expect(app.shows(text)).toBe(false);
  }
  expect(app.storage()).toEqual({});
});

test("what one run stores, the next reads back", async () => {
  const first = await open(".", { clock: {} });
  await first.press("label:Storage");
  await first.waitFor("1 opening");
  await first.type(NOTE, "Kept");
  await first.waitFor("Saved");
  const kept = first.storage();
  expect(kept.note).toBe("Kept");
  expect(kept.lastDemo).toBe("Storage");
  // The next run opens the demo again: one launch more, the note back.
  const next = await open(".", { clock: {}, storage: kept });
  for (const text of ["2 openings", "4 chars", "note"]) {
    await next.waitFor(text);
  }
  expect(next.value("text:Kept")).toBe("Kept");
  await next.back();
  await next.waitFor("APPS");
});

test("the sidebar opens the demo last selected", async () => {
  const wide = { clock: {}, width: 1200, height: 800 };
  const first = await open(".", wide);
  await first.press("label:Photos");
  await first.waitFor(PHOTOS);
  const next = await open(".", { ...wide, storage: first.storage() });
  await next.waitFor(PHOTOS);
  // A name no demo has: the first demo.
  const unknown = await open(".", { ...wide, storage: { lastDemo: "Nowhere" } });
  await unknown.waitFor("Composite");
  // The demo is opened once at launch.
  const storage = await open(".", { ...wide, storage: { lastDemo: "Storage" } });
  await storage.waitFor("1 opening");
});
