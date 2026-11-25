// UIKit regression: run this directory with `nsh test --target ios`. A page
// with a large title shows it large, its content below it and its scroll
// view at its top, as a page pushed on a stack on screen does.
import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

interface Rest {
  /** The page's top inset: the bottom of its header. */
  top: number;
  /** Its scroll view's offset (`NaN` before the first one it reports). */
  offset: number;
  /** The height its content got. */
  height: number;
}

/** Where page `name` rests once it settled. */
async function rest(app: App, name: string): Promise<Rest> {
  await app.waitFor(`text:/^${name} top:\\d+ offset:\\S+ height:\\d+/`);
  await app.wait(700);
  const line = app.texts().find((t) => t.startsWith(`${name} top:`)) ?? "";
  const [, top, offset, height] = line.match(/top:(\d+) offset:(\S+) height:(\d+)/) ?? [];
  return { top: Number(top), offset: Number(offset), height: Number(height) };
}

/** Where a large title pushed the usual way rests: the bar UIKit lays out
 * for it, which the other pages must get too. */
async function pushed(app: App): Promise<Rest> {
  await app.press("text:Push");
  const page = await rest(app, "Pushed");
  await app.press("text:Pop");
  await app.waitFor("text:/^Pushed top:/", { state: "gone" });
  return page;
}

function expectLarge(page: Rest, reference: Rest) {
  expect(page.top).toBe(reference.top);
  expect(page.offset).toBe(-page.top);
}

test("a stack shown with its first page gives it its large title", async () => {
  const app = await open("./App.tsx");
  const root = await rest(app, "Root");
  expectLarge(root, await pushed(app));
});

test("a root page replaced by one whose content and title arrive later gets its large title", async () => {
  const app = await open("./App.tsx");
  const reference = await pushed(app);
  await app.press("text:Replace");
  expectLarge(await rest(app, "Replaced"), reference);
});

test("a page whose header turns large in place, over a new scroll view, gets its large title", async () => {
  const app = await open("./App.tsx");
  const reference = await pushed(app);
  await app.press("text:Push");
  await rest(app, "Pushed");
  await app.press("text:Toggle");
  await app.waitFor("text:/^Pushed top:/", { state: "gone" });
  await app.wait(700);
  await app.press("text:Toggle");
  expectLarge(await rest(app, "Pushed"), reference);
});

test("a page whose header turns large in place, keeping its scroll view, gets its large title", async () => {
  const app = await open("./App.tsx");
  const reference = await pushed(app);
  await app.press("text:KeepPlain");
  const plain = await rest(app, "Plain");
  expect(plain.top).toBe(0);

  await app.press("text:Toggle");
  const grown = await rest(app, "Plain");
  expectLarge(grown, reference);
  expect(grown.height).toBe(reference.height);
});

test("a page whose header toggles large -> plain -> large, keeping its scroll view, shrinks and regrows cleanly", async () => {
  const app = await open("./App.tsx");
  const reference = await pushed(app);
  await app.press("text:KeepPlain");
  const plainRef = await rest(app, "Plain");

  await app.press("text:KeepLarge");
  expectLarge(await rest(app, "Keep"), reference);

  await app.press("text:Toggle");
  const plain = await rest(app, "Keep");
  expect(plain.top).toBe(0);
  expect(plain.height).toBe(plainRef.height);
  if (!Number.isNaN(plain.offset)) {
    expect(plain.offset).toBe(0);
  }

  await app.press("text:Toggle");
  expectLarge(await rest(app, "Keep"), reference);
});
