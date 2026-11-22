// The Dock demo: `nsh/base`'s `DockArea` in a desktop window (1200 × 800
// asked; a platform may give less: the gallery's sidebar beside the demo),
// its tabs dragged between groups and to their edges, its handles dragged,
// its docks toggled, its panels closed; and on a phone, its compact
// presentation. nsh/test drags by offsets, so the demo's geometry is fixed
// in any window 1000 wide or more: the area is 700 wide (a 200 left dock,
// a 500 center whose first group is 300 wide), its tabs 112 × 36 in a bar
// 37 high (its bottom border). A drag from the middle of `main.rs` (the
// first group's second tab, at 168, 18 in the center) lands where these
// steps say. Headless, the app runs as macOS: a tab drags once the pointer
// moves (touch screens hold it first).
import { beforeEach, describe, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

/** A number the demo shows after `prefix` (`"First group: "`, `"Left dock: Files, "`). */
const shown = (app: App, prefix: string) => {
  const line = app.texts().find((t) => t.startsWith(prefix));
  return line === undefined ? NaN : parseFloat(line.slice(prefix.length));
};

/** Waits for a size within 2 points of `size` (real platforms' pointers may round). */
const waitForSize = (app: App, prefix: string, size: number) => app.waitUntil(() => Math.abs(shown(app, prefix) - size) <= 2);

describe("on a desktop", () => {
  let app: App;
  beforeEach(async () => {
    app = await open("../App.tsx", { platform: "macos", width: 1200, height: 800, clock: {} });
    await app.press("role:button[Dock]");
    await app.waitFor("Center: README.md, main.rs | Preview");
  });

  test("the layout shows each group's displayed panel, and a press on a tab selects it", async () => {
    expect(app.count("role:tablist")).toBe(4);
    expect(app.shows("main.rs: 0 edits")).toBe(true);
    expect(app.shows("README.md: 0 edits")).toBe(false);
    expect(app.shows("Live preview")).toBe(true);
    expect(app.shows("src/lib.rs")).toBe(true);
    expect(app.shows("$ cargo run")).toBe(true);
    await app.press("id:tab-readme");
    await app.waitFor("README.md: 0 edits");
    expect(app.shows("main.rs: 0 edits")).toBe(false);
    expect(app.texts()).toContain("Last event: Showing README.md");
  });

  test("a tab dropped on another group's tab bar moves there, keeping its panel's state", async () => {
    await app.press("label:Edit main.rs");
    await app.press("label:Edit main.rs");
    await app.waitFor("main.rs: 2 edits");
    // Onto the second group's bar (300 to 500), past its one tab (at 356): 450.
    await app.drag("id:tab-main", { x: 282, y: 0 });
    await app.waitFor("Center: README.md | Preview, main.rs");
    expect(app.count("role:tablist")).toBe(4);
    // The same panel, displayed in its new group: its count went with it.
    expect(app.shows("main.rs: 2 edits")).toBe(true);
    expect(app.shows("README.md: 0 edits")).toBe(true);
  });

  test("a tab dropped at a group's edge splits it into a new group", async () => {
    await app.press("label:Edit main.rs");
    await app.waitFor("main.rs: 1 edit");
    // Into the left edge of the second group's content (its first 35%,
    // 300 to 370): 320, 137.
    await app.drag("id:tab-main", { x: 152, y: 119 });
    await app.waitFor("text:/^Center: \\(?README\\.md [|/] \\(?main\\.rs [|/] Preview\\)?\\)?$/");
    expect(app.count("role:tablist")).toBe(5);
    expect(app.shows("main.rs: 1 edit")).toBe(true);
    expect(app.shows("Live preview")).toBe(true);
  });

  test("dragging the handles resizes the split and the docks", async () => {
    expect(shown(app, "First group: ")).toBe(300);
    // Every handle is labelled "Resize", in tree order: the left dock's
    // edge, the center's split, the bottom dock's edge.
    expect(app.count("label:Resize")).toBe(3);
    await app.drag("label:Resize >> nth=1", { x: 60, y: 0 });
    await waitForSize(app, "First group: ", 360);
    await app.drag("label:Resize >> nth=0", { x: 40, y: 0 });
    await waitForSize(app, "Left dock: Files, ", 240);
    await app.drag("label:Resize >> nth=2", { x: 0, y: -40 });
    await waitForSize(app, "Bottom dock: Terminal, ", 200);
    expect(app.shows("Left dock: Files, 240 pt, open")).toBe(true);
  });

  test("a dock opens and closes, from the toolbar and from its own strip, and keeps its panels", async () => {
    expect(app.texts()).toContain("Showing docks: Files, Terminal");
    await app.press("label:Toggle files");
    await app.waitFor("Left dock: Files, 200 pt, closed");
    await app.waitFor("src/lib.rs", { state: "gone" });
    await app.waitFor("Showing docks: Terminal");
    await app.press("label:Toggle files");
    await app.waitFor("Left dock: Files, 200 pt, open");
    await app.waitFor("src/lib.rs");
    await app.press("label:Hide Terminal");
    await app.waitFor("Bottom dock: Terminal, 160 pt, closed");
    expect(app.shows("$ cargo run")).toBe(false);
    await app.press("label:Toggle terminal");
    await app.waitFor("$ cargo run");
  });

  test("a closed panel leaves the layout, and a locked layout moves and closes nothing", async () => {
    await app.press("label:Close README.md");
    await app.waitFor("Last event: Closed README.md");
    await app.waitFor("Center: main.rs | Preview");
    expect(app.shows("id:tab-readme")).toBe(false);
    await app.press("label:Lock the layout");
    await app.waitFor("label:Close main.rs", { state: "gone" });
    await app.drag("id:tab-main", { x: 282, y: 0 });
    await app.wait(300);
    expect(app.shows("Center: main.rs | Preview")).toBe(true);
  });

  test("the toolbar's option shows or hides every tab's close button", async () => {
    expect(app.shows("label:Close README.md")).toBe(true);
    await app.press("label:Show close buttons");
    await app.waitFor("label:Close README.md", { state: "gone" });
    expect(app.shows("label:Close Preview")).toBe(false);
    await app.press("label:Show close buttons");
    await app.waitFor("label:Close README.md");
  });

  test("the toolbar zooms the group of the tab shown last, and back", async () => {
    await app.press("id:tab-readme");
    await app.waitFor("Last event: Showing README.md");
    await app.press("label:Zoom the group");
    await app.waitFor("Zoomed: README.md");
    await app.waitFor("Live preview", { state: "gone" });
    await app.press("label:Zoom the group");
    await app.waitFor("Zoomed: none");
    await app.waitFor("Live preview");
  });
});

describe("on a phone", () => {
  let app: App;
  beforeEach(async () => {
    // 390 wide: the area is narrower than 600, compact. No dock shows at first.
    app = await open("../App.tsx", { platform: "macos", clock: {} });
    await app.press("role:button[Dock]");
    await app.waitFor("id:tab-readme");
  });

  test("the center shows one group at a time, its tab bar listing every center panel", async () => {
    for (const tab of ["id:tab-readme", "id:tab-main", "id:tab-preview"]) expect(app.shows(tab)).toBe(true);
    expect(app.shows("main.rs: 0 edits")).toBe(true);
    expect(app.shows("src/lib.rs")).toBe(false);
    // A tab of the other group shows that group.
    await app.press("label:Edit main.rs");
    await app.waitFor("main.rs: 1 edit");
    await app.press("id:tab-preview");
    await app.waitFor("Live preview");
    expect(app.shows("main.rs: 1 edit")).toBe(false);
    // Back to the editor: it kept its count.
    await app.press("id:tab-main");
    await app.waitFor("main.rs: 1 edit");
  });

  test("a dock is a drawer, presented from the toolbar and dismissed from its strip", async () => {
    // No dock shows at first; presenting one leaves the layout's `open` as it is.
    expect(app.texts()).toContain("Showing docks: none");
    await app.press("label:Toggle files");
    await app.waitFor("src/lib.rs");
    await app.waitFor("Showing docks: Files");
    expect(app.texts()).toContain("Left dock: Files, 200 pt, open");
    await app.press("label:Hide Files");
    await app.waitFor("src/lib.rs", { state: "gone" });
    await app.waitFor("Showing docks: none");
    expect(app.texts()).toContain("Left dock: Files, 200 pt, open");
  });

  test("a tab dragged along the strip reorders it, splitting nothing", async () => {
    // From the middle of the second tab to the first tab's leading half.
    await app.drag("id:tab-main", { x: -130, y: 0 });
    await app.waitFor("Center: main.rs, README.md | Preview");
  });
});
