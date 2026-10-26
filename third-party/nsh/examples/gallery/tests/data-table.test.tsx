// The DataTable demo: `nsh/base`'s `DataTable` over a million stocks whose
// quotes in view tick live, the rows in view served by the app, whose
// selection, keys, sorting, ticks and scrolling the tests walk through.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1000, height: 700 } as const;

test("the DataTable demo makes only the cells in view, and selects a row", async () => {
  const app = await open("../App.tsx", desktop);
  await app.press("role:button[DataTable]");
  await app.waitFor("Apple 1");
  // The first rows and columns are made; the last ones, far away, are not.
  expect(app.shows("Price")).toBe(true);
  expect(app.shows("Tencent 1000000")).toBe(false);
  expect(app.shows("Indicator 39")).toBe(false);
  await app.press("text:Microsoft 2");
  await app.waitFor("Row 2");
  // The arrow keys move the selection and the End key goes to the last row,
  // which the page served follows.
  await app.keyboard.press("down");
  await app.waitFor("Row 3");
  await app.keyboard.press("end");
  await app.waitFor("Row 1000000");
  await app.waitFor("Tencent 1000000");
  expect(app.shows("Apple 1")).toBe(false);
});

test("the DataTable demo selects cells and columns", async () => {
  const app = await open("../App.tsx", desktop);
  await app.press("role:button[DataTable]");
  await app.waitFor("Apple 1");
  await app.press("Cells");
  // The ID data column already supplies numbers; cell mode adds no row-number gutter.
  expect(app.count("text:7")).toBe(1);
  await app.press("text:/^US$/ >> nth=0");
  await app.waitFor("Cell row 1, Market");
  await app.keyboard.press("right");
  await app.waitFor("Cell row 1, Price");
  await app.keyboard.press("down");
  await app.waitFor("Cell row 2, Price");
  // A title selects its column.
  await app.press("text:Name");
  await app.waitFor("Column Name");
});

test("the DataTable demo sorts with a title's sort button and scrolls to a row", async () => {
  const app = await open("../App.tsx", desktop);
  await app.press("role:button[DataTable]");
  await app.waitFor("Apple 1");
  // Ascending, then descending: the app serves the rows the other way up.
  await app.press("id:sort:id");
  await app.press("id:sort:id");
  await app.waitFor("Tencent 1000000");
  await app.press("label:Go to row 500000");
  await app.waitFor("text:/rows 500000–/");
});

test("the DataTable demo's quotes tick live, and stop", async () => {
  const app = await open("../App.tsx", desktop);
  await app.press("role:button[DataTable]");
  await app.waitFor("Apple 1");
  // Ticks come every 33 ms over the million rows, colored by rise and fall.
  await app.waitFor("text:/tick [1-9]\\d/");
  await app.press("label:Toggle live updates");
  await app.waitFor("Live off");
  const ticks = () => app.texts().find((t) => t.includes(" · tick "));
  const stopped = ticks();
  await app.wait(300);
  expect(ticks()).toBe(stopped);
});

test("the DataTable demo serves the rows a far scroll lands on", async () => {
  const app = await open("../App.tsx", desktop);
  await app.press("role:button[DataTable]");
  await app.waitFor("Apple 1");
  // The rows served, not the ticks, are what this looks at.
  await app.press("label:Toggle live updates");
  await app.press("label:Go to row 500000");
  await app.waitFor("text:/rows 500000/");
  // Whatever the number of rows in view, the page served starts at a
  // whole row, so the rows landed on show their data.
  for (const by of [4000, 3990, 8020]) {
    await app.scroll("id:table", by);
    await app.wait(200);
    const range = app.texts().find((t) => t.startsWith("rows "))!;
    const first = Number(range.slice(5).split("–")[0]) - 1;
    const names = ["Apple", "Microsoft", "NVIDIA", "Tesla", "Amazon", "Alphabet", "Meta"];
    const more = ["Tencent", "Alibaba", "Meituan", "Xiaomi", "Moutai", "CATL", "DBS"];
    const all = [...names, ...more];
    await app.waitFor(`${all[first % all.length]} ${first + 1}`);
  }
});

test("the DataTable demo's horizontal bar drags the columns, and back", async () => {
  const app = await open("../App.tsx", desktop);
  await app.press("role:button[DataTable]");
  await app.waitFor("Apple 1");
  // The desktops' bar under the table leads while it is dragged: the
  // table follows it without sending its echoes back.
  await app.drag("id:data-table-scrollbar", { x: -900, y: 0 });
  await app.waitFor("TTM");
  expect(app.shows("Price")).toBe(false);
  await app.drag("id:data-table-scrollbar", { x: 900, y: 0 });
  await app.waitFor("Price");
  expect(app.shows("TTM")).toBe(false);
});
