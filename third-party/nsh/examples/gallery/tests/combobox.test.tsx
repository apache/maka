// The Combobox demo: topics picked several at once from a searchable list
// with sections, a clear button and a footer, and a reviewer picked alone.
// On a phone (headless runs are touch screens) the list is a sheet; on a
// desktop a popup.
import { beforeEach, describe, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

describe("on a phone", () => {
  let app: App;
  beforeEach(async () => {
    app = await open("../App.tsx", { clock: {} });
    await app.press("role:button[Combobox]");
    await app.waitFor("role:combobox[Topics]");
  });

  test("topics toggle in and out while the list stays open, and closing confirms them", async () => {
    await app.press("role:combobox[Topics]");
    await app.waitFor("role:option[Web]");
    expect(app.shows("2 selected")).toBe(true);
    await app.press("role:option[Web]");
    await app.waitFor("Topics: Layout, iOS, Web");
    await app.waitFor("3 selected");
    expect(app.shows("role:option[Web]")).toBe(true);
    await app.press("role:option[Layout]");
    await app.waitFor("Topics: iOS, Web");
    // An archived topic takes no press.
    expect(app.enabled("role:option[Legacy]")).toBe(false);
    await app.back();
    await app.waitFor("Topics confirmed: 2");
  });

  test("search narrows the topics, and the clear button empties them", async () => {
    await app.press("role:combobox[Topics]");
    await app.waitFor("role:option[Web]");
    await app.type("text:Search topics", "an");
    await app.waitUntil(() => app.count("role:option") === 2);
    expect(app.shows("role:option[Animation]")).toBe(true);
    expect(app.shows("role:option[Android]")).toBe(true);
    await app.back();
    await app.waitUntil(() => !app.shows("role:option[Animation]"));
    await app.press("label:Clear the topics");
    await app.waitFor("Topics: none");
    await app.waitFor("Add topics");
  });

  test("a reviewer replaces the last and closes the list", async () => {
    await app.press("role:combobox[Reviewer]");
    await app.waitFor("role:option[Grace]");
    await app.press("role:option[Grace]");
    await app.waitFor("Reviewer: Grace");
    await app.waitUntil(() => !app.shows("role:option[Ada]"));
    await app.press("role:combobox[Reviewer]");
    await app.waitFor("role:option[Linus]");
    await app.press("role:option[Linus]");
    await app.waitFor("Reviewer: Linus");
  });
});
