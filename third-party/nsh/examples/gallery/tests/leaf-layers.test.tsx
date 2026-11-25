// Plain texts drawn as layers with no view of their own (#2066), on macOS:
// a press on a label reaches its button, the button's name is read from the
// label, a scrolled list still hits and reads its rows, and a text that gets
// a listener later turns into a view that takes the press.
import { expect, open, test } from "nsh/test";

const desktop = { width: 600, height: 560 } as const;

type App = Awaited<ReturnType<typeof open>>;

async function onMac(body: (app: App) => Promise<void>) {
  const app = await open("./fixtures/leaf-layers.tsx", desktop);
  if (!app.shows("Platform: macos")) return;
  await body(app);
}

test("a press on a leaf label reaches its button", () =>
  onMac(async (app) => {
    await app.press("text:Save draft");
    await app.waitFor("text:Saves [1]");
  }));

test("a button's accessible name is read from its leaf label", () =>
  onMac(async (app) => {
    expect(app.shows("role:button[Save draft]")).toBe(true);
    await app.press("role:button[Save draft]");
    await app.waitFor("text:Saves [1]");
  }));

test("a leaf that gets a listener takes the press", () =>
  onMac(async (app) => {
    await app.press("role:button[Make live]");
    await app.press("text:Tap target");
    await app.waitFor("text:Taps [1]");
    // Its siblings, views again, still show and hit nothing of their own.
    expect(app.shows("text:Quiet before")).toBe(true);
    expect(app.shows("text:Quiet after")).toBe(true);
  }));

test("leaf rows scroll and stay in place", () =>
  onMac(async (app) => {
    await app.scroll("id:rows", 480);
    await app.waitUntil(() => app.texts().some((t) => t.startsWith("Offset [") && t !== "Offset [0]"));
    expect(app.shows("text:Leaf row 25")).toBe(true);
  }));
