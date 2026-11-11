// Cmd+C copies text selected while an input keeps the keyboard focus (a
// chat's composer): the Edit menu's Copy reaches the input's editor first,
// which, with nothing of its own selected, copies the selection around it.
// What the editor itself selects still copies first. macOS only; the
// clipboard is put back after, even when a test fails.
import { expect, open, test } from "nsh/test";

const desktop = { width: 600, height: 560 } as const;

type App = Awaited<ReturnType<typeof open>>;

// Runs `body` on the fixture on macOS, the clipboard put back after.
async function onMac(body: (app: App) => Promise<void>) {
  const app = await open("./fixtures/copy-selection.tsx", desktop);
  if (!app.shows("Platform: macos")) return;
  try {
    await app.waitFor("text:Clipboard [copy-selection sentinel]");
    await body(app);
  } finally {
    await app.press("text:Restore");
    await app.waitFor("text:Clipboard restored");
  }
}

// Selects across the selectable view's two texts: the selected text.
async function selectArea(app: App): Promise<string> {
  // From the first line's end into the second.
  await app.drag("text:Alpha beta gamma", { x: 0, y: 40 });
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("Area [") && t.includes("Delta")));
  const area = app.texts().find((t) => t.startsWith("Area ["))!;
  return area.slice("Area [".length, -1);
}

// Focuses input `id`; it keeps the focus while text is selected.
async function focus(app: App, id: "composer" | "notes") {
  await app.press(`id:${id}`);
  await app.waitFor(`text:Focus [${id}]`);
}

for (const id of ["composer", "notes"] as const) {
  test(`Cmd+C copies a selectable view's selection while ${id} has the focus`, () =>
    onMac(async (app) => {
      await focus(app, id);
      const selected = await selectArea(app);
      // The scenario: the input still has the focus.
      expect(app.shows(`text:Focus [${id}]`)).toBe(true);
      await app.keyboard.press("cmd+c");
      await app.waitFor(`text:Clipboard [${selected}]`, { timeout: 2000 });
    }));

  test(`Cmd+C copies a selectable text's selection while ${id} has the focus`, () =>
    onMac(async (app) => {
      await focus(app, id);
      // Back from the text's middle: some of its first words.
      await app.drag("text:Zeta eta theta iota", { x: -60, y: 0 });
      expect(app.shows(`text:Focus [${id}]`)).toBe(true);
      await app.keyboard.press("cmd+c");
      await app.waitUntil(
        () => {
          const board = app.texts().find((t) => t.startsWith("Clipboard ["));
          const copied = board?.slice("Clipboard [".length, -1) ?? "";
          return copied !== "copy-selection sentinel" && copied.length > 0 && "Zeta eta theta iota".includes(copied);
        },
        { timeout: 2000 },
      );
    }));

  test(`Cmd+C in ${id} copies its own selection first`, () =>
    onMac(async (app) => {
      // Text selected around the input, then text selected in it.
      await focus(app, id);
      await selectArea(app);
      await app.type(`id:${id}`, "own words");
      await app.waitFor(`text:Focus [${id}]`);
      await app.keyboard.press("cmd+a");
      await app.keyboard.press("cmd+c");
      await app.waitFor("text:Clipboard [own words]", { timeout: 2000 });
      // Paste still pastes into the input.
      await app.keyboard.press("right");
      await app.keyboard.press("cmd+v");
      await app.waitUntil(() => app.value(`id:${id}`) === "own wordsown words", { timeout: 2000 });
    }));
}

test("Cmd+C with nothing selected leaves the clipboard as it was", () =>
  onMac(async (app) => {
    await focus(app, "composer");
    await app.keyboard.press("cmd+c");
    // A few clipboard reads later: still the sentinel.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(app.shows("text:Clipboard [copy-selection sentinel]")).toBe(true);
  }));
