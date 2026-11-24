// `DataTable`'s columns that grow (`grow`) into the width the columns leave
// free, and fit their content once their rows come (`autoFit`)
// (`fixtures/data-table-fit-grow.tsx`).
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 600, height: 400 } as const;

async function start() {
  const app = await open("./fixtures/data-table-fit-grow.tsx", desktop);
  await app.waitFor("Email");
  return app;
}

/** The widths the ref reports now. */
async function widths(app: Awaited<ReturnType<typeof start>>): Promise<number[]> {
  await app.press("widths");
  await app.wait(50);
  const text = app.texts().find((t) => t.includes("widths="))!;
  return text.match(/widths=([\d,]+)/)![1].split(",").map(Number);
}

test("columns that grow share the free width by their grow, and follow the table's width", async () => {
  const app = await start();
  // 560 - 240 = 320 free: name a quarter, email three.
  expect(await widths(app)).toEqual([80, 160, 320]);
  await app.press("narrow");
  await app.wait(50);
  expect(await widths(app)).toEqual([80, 120, 200]);
  // Narrower than the columns: nothing grows, the table scrolls.
  await app.press("tiny");
  await app.wait(50);
  expect(await widths(app)).toEqual([80, 80, 80]);
  expect(app.shows("text:/resize=/")).toBe(false);
});

test("autoFit fits a column once its rows come, and later rows leave it", async () => {
  const app = await start();
  await app.press("load");
  await app.waitFor("Ada");
  const [, name, email] = await widths(app);
  // Email fitted to its text, then grown: the two fill the table.
  expect(80 + name + email).toBe(560);
  expect(email).toBeGreaterThan(320);
  expect(app.shows("text:/resize=/")).toBe(false);
  await app.press("longer");
  await app.waitFor("Grace");
  expect(await widths(app)).toEqual([80, name, email]);
});

test("autoFit fits a column of a new key again", async () => {
  const app = await start();
  await app.press("load");
  await app.waitFor("Ada");
  const before = await widths(app);
  await app.press("longer");
  await app.waitFor("Grace");
  await app.press("new-keys");
  await app.wait(50);
  const after = await widths(app);
  expect(after[2]).toBeGreaterThan(before[2]);
  expect(after[0] + after[1] + after[2]).toBe(560);
});

test("a column the user resizes keeps its width, and the others take the free width", async () => {
  const app = await start();
  await app.drag("id:resize:namea", { x: -40, y: 0 });
  await app.waitFor("text:/resize=name:\\d+/");
  const [, name, email] = await widths(app);
  expect(name).toBeLessThan(160);
  expect(80 + name + email).toBe(560);
  // It no longer grows when the table widens back.
  await app.press("narrow");
  await app.wait(50);
  expect((await widths(app))[1]).toBe(name);
});

test("a width the app sets is kept instead of growing", async () => {
  const app = await start();
  await app.press("set-width");
  await app.wait(50);
  expect(await widths(app)).toEqual([80, 100, 380]);
});
