// Ctrl+C copies text selected while an input keeps the keyboard focus (a
// chat's composer): the focused input takes the key first, and with nothing
// of its own selected it leaves it to the selection around it. What the
// input itself selects still copies first. Windows only.
//
// What a copy put on the clipboard is read back by pasting it into the input:
// the app's `Clipboard` in a test is the test's own memory, not the system's
// clipboard that the platform's copy writes.
import { expect, open, test } from "nsh/test";

const desktop = { width: 600, height: 560 } as const;

type App = Awaited<ReturnType<typeof open>>;

// Runs `body` on the copy-selection fixture, on Windows.
async function onWindows(body: (app: App) => Promise<void>) {
  const app = await open("./fixtures/copy-selection.tsx", desktop);
  if (!app.shows("Platform: windows")) return;
  await body(app);
}

// Selects across the selectable view's two texts: the selected text.
async function selectArea(app: App): Promise<string> {
  // From the first line's end into the second.
  await app.drag("text:Alpha beta gamma", { x: 0, y: 40 });
  await app.waitUntil(() => app.texts().some((t) => t.startsWith("Area [") && t.includes("Delta")));
  const area = app.texts().find((t) => t.startsWith("Area ["))!;
  return area.slice("Area [".length, -1);
}

// Focuses input `id` by typing nothing in it: an input is not among the
// pressable views on Windows, and it keeps the focus while text is selected.
async function focus(app: App, id: "composer" | "notes") {
  await app.type(`id:${id}`, "");
  await app.waitFor(`text:Focus [${id}]`);
}

for (const id of ["composer", "notes"] as const) {
  test(`Ctrl+C copies a selectable view's selection while ${id} has the focus`, () =>
    onWindows(async (app) => {
      await focus(app, id);
      const selected = await selectArea(app);
      // The scenario: the input still has the focus.
      expect(app.shows(`text:Focus [${id}]`)).toBe(true);
      await app.keyboard.press("ctrl+c");
      await app.keyboard.press("ctrl+v");
      await app.waitUntil(() => app.value(`id:${id}`) === selected, { timeout: 2000 });
    }));

  test(`Ctrl+C copies a selectable text's selection while ${id} has the focus`, () =>
    onWindows(async (app) => {
      await focus(app, id);
      // Back from the text's middle: some of its first words.
      await app.drag("text:Zeta eta theta iota", { x: -60, y: 0 });
      expect(app.shows(`text:Focus [${id}]`)).toBe(true);
      await app.keyboard.press("ctrl+c");
      await app.keyboard.press("ctrl+v");
      await app.waitUntil(
        () => {
          const pasted = app.value(`id:${id}`);
          return pasted.length > 0 && "Zeta eta theta iota".includes(pasted);
        },
        { timeout: 2000 },
      );
    }));

  test(`Ctrl+C in ${id} copies its own selection first`, () =>
    onWindows(async (app) => {
      // The input's own text selected, then text selected around it, which
      // does not take the selection of the input (it keeps the focus).
      await focus(app, id);
      await app.type(`id:${id}`, "own words");
      await app.keyboard.press("ctrl+a");
      await selectArea(app);
      await app.waitFor(`text:Focus [${id}]`);
      await app.keyboard.press("ctrl+c");
      // Paste after its end: the copy was the input's own words.
      await app.keyboard.press("right");
      await app.keyboard.press("ctrl+v");
      await app.waitUntil(() => app.value(`id:${id}`) === "own wordsown words", { timeout: 2000 });
    }));
}
