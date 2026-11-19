// The SplitView demo: `nsh/base`'s `SplitView` of mailboxes, a mailbox's
// messages and a message, each column a `NavStack`. In a desktop window the
// columns stand side by side and the messages' header hides and shows the
// sidebar; in a phone's width one column shows at a time, a selection
// bringing the next one in front and the header's back returning. Headless,
// the app runs as macOS (the iOS split is UIKit's, checked on a device).
import { beforeEach, describe, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

describe("on a desktop", () => {
  let app: App;
  beforeEach(async () => {
    app = await open("../App.tsx", { platform: "macos", width: 1400, height: 800, clock: {} });
    await app.press("role:button[SplitView]");
    await app.waitFor("Design review on Thursday");
  });

  test("the columns stand side by side, and a message shows in the detail", async () => {
    expect(app.shows("Archive")).toBe(true);
    expect(app.shows("Lucas Moreau")).toBe(true);
    await app.press("label:Aiko Tanaka, Lunch next week?");
    // The message's line under its sender: the list shows the time alone.
    await app.waitFor("To me · Yesterday");
    expect(app.shows("Archive")).toBe(true);
  });

  test("the messages' header hides and shows the sidebar", async () => {
    await app.press("label:Hide the mailboxes");
    await app.waitFor("Archive", { state: "gone" });
    expect(app.shows("Lucas Moreau")).toBe(true);
    await app.press("label:Show the mailboxes");
    await app.waitFor("Archive");
  });

  test("the detail pushes a reply in its own column", async () => {
    await app.press("label:Reply");
    await app.waitFor("label:Reply text");
    expect(app.shows("Lucas Moreau")).toBe(true);
    await app.press("label:Back to the message");
    await app.waitFor("label:Reply text", { state: "gone" });
  });
});

describe("on a phone", () => {
  let app: App;
  beforeEach(async () => {
    // 390 wide: horizontally compact, one column at a time.
    app = await open("../App.tsx", { platform: "macos", clock: {} });
    await app.press("role:button[SplitView]");
    await app.waitFor("Starred");
  });

  test("a selection brings the next column in front, and back returns", async () => {
    // Aiko's message is in the inbox's list only; the message's line under
    // its sender ("To me · …") in the detail only.
    expect(app.shows("Aiko Tanaka")).toBe(false);
    await app.press("label:Inbox");
    await app.waitFor("Aiko Tanaka");
    expect(app.shows("Starred")).toBe(false);
    await app.press("label:Lucas Moreau, Release notes for 0.6");
    await app.waitFor("To me · 8:15");
    expect(app.shows("Aiko Tanaka")).toBe(false);
    await app.press("label:Back to Inbox");
    await app.waitFor("Aiko Tanaka");
    expect(app.shows("To me · 8:15")).toBe(false);
    await app.press("label:Back to Mailboxes");
    await app.waitFor("Starred");
    expect(app.shows("Aiko Tanaka")).toBe(false);
  });

  test("the mailboxes lead back to the gallery", async () => {
    await app.press("label:Back to the gallery");
    await app.waitFor("Starred", { state: "gone" });
  });
});
