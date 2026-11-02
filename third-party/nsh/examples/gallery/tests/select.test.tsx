// The Select demo: a sort order chosen with a press or the
// keys, a font list with sections, search, an empty state and a font that
// is not installed, and a language the organization sets (disabled); a sort
// menu in a list header, countries with their flags, and an issue's status,
// required team and locked priority. On a
// phone (headless runs are touch screens) the list is a sheet; on a
// desktop a popup, whose rows the pointer highlights and whose search field
// takes the keyboard at once.
import { beforeEach, describe, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

describe("on a phone", () => {
  let app: App;
  beforeEach(async () => {
    app = await open("../App.tsx", { clock: {} });
    await app.press("role:button[Select]");
    await app.waitFor("role:combobox[Sort by]");
  });

  test("a press opens the list and a press on an option chooses it", async () => {
    expect(app.count("role:combobox")).toBe(8);
    await app.press("role:combobox[Sort by]");
    await app.waitFor("role:option[Oldest first]");
    expect(app.count("role:option")).toBe(5);
    await app.press("role:option[Oldest first]");
    await app.waitFor("Sort by: Oldest first");
    await app.waitUntil(() => !app.shows("role:option[Name]"));
  });

  test("the keys move the highlight from the chosen item and Return chooses", async () => {
    // Opened on the chosen order (Newest first): Down goes on to the next.
    await app.press("role:combobox[Sort by]");
    await app.waitFor("role:option[Newest first]");
    await app.keyboard.press("down");
    await app.keyboard.press("enter");
    await app.waitFor("Sort by: Oldest first");
    // End: the last order.
    await app.press("role:combobox[Sort by]");
    await app.waitFor("role:option[Name]");
    await app.keyboard.press("end");
    await app.keyboard.press("enter");
    await app.waitFor("Sort by: Kind");
    // A letter jumps to the next title starting with it.
    await app.press("role:combobox[Sort by]");
    await app.waitFor("role:option[Name]");
    await app.keyboard.press("s");
    await app.keyboard.press("enter");
    await app.waitFor("Sort by: Size");
  });

  test("search filters the fonts by title, and a search with no match shows the empty state", async () => {
    await app.press("role:combobox[Font]");
    await app.waitFor("role:option[Georgia]");
    expect(app.texts()).toContain("SERIF");
    // A font that is not installed takes no press.
    expect(app.enabled("role:option[Playfair Display]")).toBe(false);
    await expect(() => app.press("role:option[Playfair Display]")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
    // Ignoring case; the sections without a match go. Each match shows its
    // title (the rows the app draws stay in their own rows as others go).
    await app.type("text:Search fonts", "M");
    await app.waitUntil(() => app.count("role:option") === 5);
    for (const font of ["Merriweather", "Times New Roman", "JetBrains Mono", "Menlo", "SF Mono"]) {
      expect(app.texts()).toContain(font);
    }
    await app.type("text:/^M$/", "ONO");
    await app.waitUntil(() => app.count("role:option") === 2);
    expect(app.shows("role:option[JetBrains Mono]")).toBe(true);
    expect(app.texts()).toContain("MONOSPACE");
    expect(app.texts()).not.toContain("SERIF");
    await app.press("role:option[SF Mono]");
    await app.waitFor("Font: SF Mono");
    // Each opening starts with an empty search.
    await app.press("role:combobox[Font]");
    await app.waitFor("role:option[Georgia]");
    await app.type("text:Search fonts", "zzz");
    await app.waitFor("No font matches");
    expect(app.count("role:option")).toBe(0);
    // Back closes it, with nothing chosen.
    await app.back();
    await app.waitUntil(() => !app.shows("No font matches"));
    expect(app.texts()).toContain("SF Mono");
  });

  test("a disabled select does not open", async () => {
    expect(app.enabled("role:combobox[Language]")).toBe(false);
    await expect(() => app.press("role:combobox[Language]")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  });

  test("a sort menu in a list header orders the downloads, and its arrow turns the order round", async () => {
    await app.press("role:combobox[Sort downloads]");
    await app.waitFor("role:option[Size]");
    await app.press("role:option[Size]");
    await app.waitFor("Downloads: Size, largest first");
    // The column sorted on leads at the rows' trailing edge.
    expect(app.texts()).toContain("1.2 GB");
    await app.press("role:button[Descending]");
    await app.waitFor("Downloads: Size, smallest first");
    expect(app.shows("role:button[Ascending]")).toBe(true);
    // Another order starts its own way round: names from A.
    await app.press("role:combobox[Sort downloads]");
    await app.waitFor("role:option[Name]");
    await app.press("role:option[Name]");
    await app.waitFor("Downloads: Name, A to Z");
  });

  test("countries show their flags and codes by region, search narrows them, and one is not shipped to", async () => {
    await app.press("role:combobox[Country]");
    await app.waitFor("role:option[Japan]");
    expect(app.texts()).toContain("EUROPE");
    await app.type("text:Search countries", "bra");
    await app.waitUntil(() => app.count("role:option") === 1);
    expect(app.enabled("role:option[Brazil]")).toBe(false);
    await app.clear("text:bra");
    await app.type("text:Search countries", "port");
    await app.waitUntil(() => app.count("role:option") === 1);
    await app.press("role:option[Portugal]");
    await app.waitFor("Country: Portugal");
    await app.waitFor("+351");
    expect(app.texts()).toContain("5–7 days");
  });

  test("an issue needs a team: filing without one says so, and a locked priority does not open", async () => {
    expect(app.texts()).toContain("Required: who picks it up");
    await app.press("role:button[File issue]");
    await app.waitFor("Issue: a team is required");
    await app.waitFor("Choose a team to file the issue");
    await app.press("role:combobox[Team]");
    await app.waitFor("role:option[Platform]");
    await app.press("role:option[Platform]");
    await app.waitFor("Team: Platform");
    await app.waitFor("Required: who picks it up");
    await app.press("role:combobox[Status]");
    await app.waitFor("role:option[In review]");
    await app.press("role:option[In review]");
    await app.waitFor("Status: In review");
    await app.press("role:button[File issue]");
    await app.waitFor("Issue filed: In review, Platform");
    await app.waitFor("Filed as NSH-612");
    expect(app.enabled("role:combobox[Priority]")).toBe(false);
  });
});

describe("on a desktop", () => {
  let app: App;
  beforeEach(async () => {
    app = await open("../App.tsx", { platform: "macos", width: 1200, height: 800, clock: {} });
    await app.press("role:button[Select]");
    await app.waitFor("role:combobox[Sort by]");
  });

  test("the pointer highlights a row and Return chooses it", async () => {
    await app.press("role:combobox[Sort by]");
    await app.waitFor("role:option[Name]");
    await app.hover("role:option[Name]");
    await app.keyboard.press("enter");
    await app.waitFor("Sort by: Name");
    await app.waitUntil(() => !app.shows("role:option[Size]"));
  });

  test("the search field takes the keyboard as the list opens, and Return chooses the first match", async () => {
    await app.press("role:combobox[Font]");
    await app.waitFor("role:option[Georgia]");
    await app.type("text:Search fonts", "geo");
    await app.waitUntil(() => app.count("role:option") === 1);
    await app.keyboard.press("enter");
    await app.waitFor("Font: Georgia");
    // Escape closes the list without choosing.
    await app.press("role:combobox[Font]");
    await app.waitFor("role:option[Inter]");
    await app.keyboard.press("escape");
    await app.waitUntil(() => !app.shows("role:option[Inter]"));
    expect(app.texts()).toContain("Font: Georgia");
  });
});
