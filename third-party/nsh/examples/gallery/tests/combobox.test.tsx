// The Combobox demo: topics picked several at once from a searchable list
// with sections, a clear button and a footer, and a reviewer picked alone;
// assignees with their faces as chips, up to four; labels, a new one
// created from the query; a command list that keeps no value.
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

  test("assignees show as chips with their faces, up to four, and a chip's cross takes one off", async () => {
    await app.press("role:combobox[Assignees]");
    await app.waitFor("role:option[Alan Turing]");
    await app.press("role:option[Alan Turing]");
    await app.waitFor("Assignees: Ada Lovelace, Grace Hopper, Alan Turing");
    await app.press("role:option[Katherine Johnson]");
    await app.waitFor("Assignees: Ada Lovelace, Grace Hopper, Alan Turing, Katherine Johnson");
    // Four: nobody else can be added, and someone away never can.
    await app.waitUntil(() => !app.enabled("role:option[Linus Torvalds]"));
    expect(app.enabled("role:option[Dennis Ritchie]")).toBe(false);
    await app.back();
    await app.waitUntil(() => !app.shows("role:option[Alan Turing]"));
    await app.press("label:Remove Ada Lovelace");
    await app.waitFor("Assignees: Grace Hopper, Alan Turing, Katherine Johnson");
    expect(app.shows("label:Remove Ada Lovelace")).toBe(false);
  });

  test("a label that does not exist is offered, and choosing the offer creates it", async () => {
    await app.press("role:combobox[Labels]");
    await app.waitFor("role:option[feature]");
    await app.type("text:Search or create labels", "flaky");
    await app.waitFor("role:option[Create “flaky”]");
    expect(app.count("role:option")).toBe(1);
    await app.press("role:option[Create “flaky”]");
    await app.waitFor("Labels: bug, flaky");
    // The query is emptied, and the new label is one of the list.
    await app.waitFor("role:option[flaky]");
    expect(app.shows("role:option[Create “flaky”]")).toBe(false);
    // A label's title, whatever its case, is never offered again.
    await app.type("text:Search or create labels", "BUG");
    await app.waitUntil(() => app.count("role:option") === 1);
    expect(app.shows("role:option[bug]")).toBe(true);
    await app.back();
    await app.waitUntil(() => !app.shows("role:option[bug]"));
    await app.press("label:Remove the label flaky");
    await app.waitFor("Labels: bug");
  });

  test("a command list runs the command chosen and keeps no value", async () => {
    expect(app.texts()).toContain("Nothing run yet");
    await app.press("role:combobox[Command]");
    await app.waitFor("role:option[New file]");
    expect(app.texts()).toContain("APPEARANCE");
    expect(app.enabled("role:option[Reset zoom]")).toBe(false);
    await app.type("text:Type a command", "term");
    await app.waitUntil(() => app.count("role:option") === 1);
    await app.press("role:option[Toggle terminal]");
    await app.waitFor("Command: Toggle terminal");
    await app.waitFor("Ran “Toggle terminal”");
    await app.waitUntil(() => !app.shows("role:option[New file]"));
  });
});
