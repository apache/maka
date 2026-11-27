// A chat's composer that grows with its text, in Windows' own text box
// (RichEdit), as the user types, clicks and moves in it. Windows only: the
// lines are RichEdit's, which wraps them, scrolls them and places the caret
// itself.
import { expect, open, test } from "nsh/test";

const desktop = { width: 600, height: 500 } as const;

type App = Awaited<ReturnType<typeof open>>;

// The caret in the input: x, y, height.
function caret(app: App): [number, number, number] {
  const shown = app.texts().find((t) => t.startsWith("Caret "))!.slice(6);
  const [x, y, h] = shown.split(" ").map(Number);
  return [x, y, h];
}

function height(app: App): number {
  return Number(app.texts().find((t) => t.startsWith("Height "))!.slice(7));
}

// Types into the composer until its text takes `lines` lines (2 or 3): the
// distance between its lines.
async function typeLines(app: App, lines: number): Promise<number> {
  await app.type("id:composer", "你好");
  await app.waitUntil(() => height(app) > 0 && caret(app)[2] > 0);
  const one = height(app);
  const more = async (than: number) => {
    while (height(app) <= than) {
      await app.type("id:composer", " 你好世界 hello");
    }
  };
  await more(one);
  const pitch = height(app) - one;
  if (lines > 2) await more(one + pitch);
  return pitch;
}

test("a composer grown to its text shows its lines from the first, the caret on the last", async () => {
  const app = await open("./fixtures/input-composer.tsx", desktop);
  if (!app.shows("text:Platform: windows")) return;
  const pitch = await typeLines(app, 2);
  // Nothing scrolled away (and nothing blank below): the caret is on the
  // second line.
  await app.waitUntil(() => {
    const [, y, h] = caret(app);
    return y >= pitch / 2 && y + h <= height(app) + 1;
  });
  const [, y] = caret(app);
  expect(Math.abs(y - pitch)).toBeLessThan(pitch / 2);
});

test("a press on the middle line of three puts the caret there, End at its end, Ctrl+End on the last", async () => {
  const app = await open("./fixtures/input-composer.tsx", desktop);
  if (!app.shows("text:Platform: windows")) return;
  const pitch = await typeLines(app, 3);
  const on = (line: number, y: number) => Math.abs(y - pitch * line) < pitch / 2;
  // A click at the input's middle (282 points wide): the second line,
  // halfway across.
  await app.drag("id:composer", { x: 0, y: 0 });
  await app.waitUntil(() => {
    const [x, y] = caret(app);
    return on(1, y) && Math.abs(x - 141) <= 20;
  });
  await app.keyboard.press("End");
  await app.waitUntil(() => {
    const [x, y] = caret(app);
    return on(1, y) && x > 200;
  });
  await app.keyboard.press("Control+End");
  await app.waitUntil(() => {
    const [, y, h] = caret(app);
    return on(2, y) && y + h <= height(app) + 1;
  });
  expect(on(2, caret(app)[1])).toBe(true);
});
