// `DataTable`'s interactions, one by one: presses, double presses and
// context menus on rows, cells and titles, the keys, sorting, resizing and
// moving columns, the empty and loading slots, loading more, the ref's
// methods and the columns' classes (`fixtures/data-table-interactions.tsx`,
// which writes each event out).
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 600, height: 500 } as const;
const fixture = "./fixtures/data-table-interactions.tsx";

async function start() {
  const app = await open(fixture, desktop);
  await app.waitFor("Person 0");
  return app;
}

test("a press selects a row, a second one is a double press", async () => {
  const app = await start();
  await app.press("text:Person 3");
  await app.waitFor("text:/sel=3:-/");
  await app.waitFor("text:/press=3:1:1/");
  // A double press names the cell under the pointer.
  await app.press("text:Person 3");
  await app.waitFor("text:/double=3:1/");
  await app.waitFor("text:/press=3:1:2/");
  await app.press("text:Person 5");
  await app.waitFor("text:/sel=5:-/");
});

test("a row is not selected when rowSelectable is off", async () => {
  const app = await start();
  await app.press("rows");
  await app.press("text:Person 3");
  await app.wait(100);
  expect(app.shows("text:/sel=/")).toBe(false);
});

test("cells select one by one; the row header, or a selected cell pressed again, selects the row", async () => {
  const app = await start();
  await app.press("cells");
  await app.press("text:Lima >> nth=0");
  await app.waitFor("text:/sel=1:2/");
  // With the row header shown, its number selects the row (Person 2's 3 is
  // the second "3": the first is the ID column's).
  await app.press("text:3 >> nth=1");
  await app.waitFor("text:/sel=2:-/");
  await app.press("no-header");
  await app.press("text:Lima >> nth=0");
  await app.waitFor("text:/sel=1:2/");
  await app.wait(600);
  await app.press("text:Lima >> nth=0");
  await app.waitFor("text:/sel=1:-/");
  // A cell of a column that does not select selects nothing.
  await app.wait(600);
  await app.press("text:note 2");
  await app.wait(100);
  expect(app.shows("text:/sel=1:-/")).toBe(true);
});

test("the row header shows with cells, unless rowHeader is off", async () => {
  const app = await start();
  // The ID column's 7, then the row number of Person 6 too.
  expect(app.count("text:7")).toBe(1);
  await app.press("cells");
  await app.waitFor("text:7 >> nth=1");
  expect(app.count("text:7")).toBe(2);
  await app.press("no-header");
  await app.wait(100);
  expect(app.count("text:7")).toBe(1);
});

test("a title selects its column unless columns or the column are not selectable", async () => {
  const app = await start();
  await app.press("text:City");
  await app.waitFor("text:/sel=-:2/");
  // Note's column is not selectable.
  await app.press("text:Note");
  await app.wait(100);
  expect(app.shows("text:/sel=-:2/")).toBe(true);
  await app.press("cols");
  await app.press("text:Change");
  await app.wait(100);
  expect(app.shows("text:/sel=-:2/")).toBe(true);
});

test("the keys move the selection, Escape clears it, the shortcut copies it", async () => {
  const app = await start();
  await app.press("text:Person 3");
  await app.waitFor("text:/sel=3:-/");
  await app.keyboard.press("down");
  await app.waitFor("text:/sel=4:-/");
  await app.keyboard.press("up");
  await app.waitFor("text:/sel=3:-/");
  await app.keyboard.press("pagedown");
  await app.waitFor("text:/sel=(1[0-9]):-/");
  await app.keyboard.press("home");
  await app.waitFor("text:/sel=0:-/");
  // At the first row, up stays without loopSelection.
  await app.keyboard.press("up");
  await app.wait(100);
  expect(app.shows("text:/sel=0:-/")).toBe(true);
  await app.keyboard.press("end");
  await app.waitFor("text:/sel=59:-/");
  await app.waitFor("Person 59");
  await app.keyboard.press("pageup");
  await app.waitFor("text:/sel=(4[0-9]|5[0-8]):-/");
  await app.keyboard.press("mod+c");
  expect(app.clipboard()).toMatch(/^\d+\tPerson \d+\t\w+\t-?\d+\tnote \d+$/);
  await app.keyboard.press("escape");
  await app.waitFor("text:/sel=none/");
});

test("Tab reaches the table as one stop, and Escape lets Tab move on", async () => {
  const app = await start();
  // Tab goes from stop to stop until it reaches the table, whose rows,
  // titles and sort buttons are no stops of their own; the first arrow key
  // there selects the first row. (Where Tab starts is the platform's: a
  // browser starts where the page was last clicked.)
  let tabs = 0;
  while (!app.shows("text:/sel=0:-/")) {
    expect(++tabs).toBeLessThan(40);
    await app.keyboard.press("tab");
    await app.keyboard.press("down");
    await app.wait(50);
  }
  await app.keyboard.press("down");
  await app.waitFor("text:/sel=1:-/");
  // Escape clears the selection, then gives the keyboard back: Shift+Tab
  // moves on, to the stop before the table, and the arrow keys leave it.
  await app.keyboard.press("escape");
  await app.waitFor("text:/sel=none/");
  await app.keyboard.press("escape");
  await app.keyboard.press("shift+tab");
  await app.keyboard.press("down");
  await app.wait(100);
  expect(app.shows("text:/sel=none/")).toBe(true);
  // Return presses the stop Tab is on: the last switch, which reads the
  // table.
  await app.keyboard.press("enter");
  await app.waitFor("text:/read=none rows/");
});

test("loopSelection wraps the arrow keys, and Tab moves between cells", async () => {
  const app = await start();
  await app.press("loop");
  await app.press("text:Person 0");
  await app.waitFor("text:/sel=0:-/");
  await app.keyboard.press("up");
  await app.waitFor("text:/sel=59:-/");
  await app.keyboard.press("down");
  await app.waitFor("text:/sel=0:-/");
  await app.press("cells");
  await app.press("text:Oslo >> nth=0");
  await app.waitFor("text:/sel=0:2/");
  await app.keyboard.press("tab");
  await app.waitFor("text:/sel=0:3/");
  await app.keyboard.press("shift+tab");
  await app.waitFor("text:/sel=0:2/");
  await app.keyboard.press("left");
  await app.waitFor("text:/sel=0:1/");
  await app.keyboard.press("mod+c");
  expect(app.clipboard()).toBe("Person 0");
});

test("a secondary press asks for a context menu at a cell or a title", async () => {
  const app = await start();
  await app.rightClick("text:Person 2");
  await app.waitFor("text:/menu=2:1/");
  await app.rightClick("text:City");
  await app.waitFor("text:/menu=-:2/");
  // The ref reads the menu's mark and drops it when the app's menu closes;
  // where cells do not select, a row's menu marks the row.
  await app.press("menu-target");
  await app.waitFor("text:/target=-:2/");
  await app.rightClick("text:Person 2");
  await app.press("menu-target");
  await app.waitFor("text:/target=2:-/");
  await app.press("clear-target");
  await app.press("menu-target");
  await app.waitFor("text:/target=none/");
});

test("a sort button sorts ascending, descending, then not at all", async () => {
  const app = await start();
  // The title selects the column; only the button sorts.
  await app.press("text:Name");
  await app.wait(100);
  expect(app.shows("text:/sort=/")).toBe(false);
  await app.press("id:sort:id");
  await app.waitFor("text:/sort=id ascending/");
  await app.press("id:sort:id");
  await app.waitFor("text:/sort=id descending/");
  await app.waitFor("Person 59");
  expect(app.shows("Person 0")).toBe(false);
  await app.press("id:sort:id");
  await app.waitFor("text:/sort=none/");
  await app.waitFor("Person 0");
  // City is not sortable: it has no button.
  expect(app.shows("id:sort:city")).toBe(false);
});

test("a resize handle resizes within the column's limits", async () => {
  const app = await start();
  await app.drag("id:resize:name", { x: 50, y: 0 });
  await app.waitFor("text:/resize=name 170/");
  await app.drag("id:resize:name", { x: 500, y: 0 });
  await app.waitFor("text:/resize=name 300/");
  await app.drag("id:resize:name", { x: -500, y: 0 });
  await app.waitFor("text:/resize=name 80/");
  await app.press("widths");
  await app.waitFor("text:/widths=60,80,90,90,120/");
  // Note is not resizable.
  expect(app.shows("id:resize:note")).toBe(false);
});

test("a title dragged sideways moves its column, not the fixed ones", async () => {
  const app = await start();
  await app.drag("text:City", { x: -110, y: 0 });
  await app.waitFor("text:/move=city 2>1 id,city,name,change,note/");
  await app.press("dump");
  await app.waitFor("text:/dump=ID\\|City\\|Name\\|Change\\|Note/");
  // Note's column does not move, and nothing moves past the fixed ID.
  await app.drag("text:Note", { x: -200, y: 0 });
  await app.drag("text:Name", { x: -300, y: 0 });
  await app.wait(100);
  await app.press("dump");
  await app.waitFor("text:/dump=ID\\|/");
  // Without movableColumns, titles do not move.
  await app.press("fixed-moves");
  await app.drag("text:Change", { x: -200, y: 0 });
  await app.wait(100);
  expect(app.shows("text:/move=change/")).toBe(false);
});

test("the empty and loading slots show in place of rows", async () => {
  const app = await start();
  await app.press("empty");
  await app.waitFor("No rows");
  expect(app.shows("Person 0")).toBe(false);
  await app.press("loading");
  await app.waitFor("Loading rows");
  await app.press("empty");
  await app.press("loading");
  await app.waitFor("Person 0");
  expect(app.shows("No rows")).toBe(false);
});

test("hasMore loads more once the last rows come within the threshold", async () => {
  const app = await start();
  await app.press("more");
  await app.scroll("id:t", 400);
  await app.wait(100);
  expect(app.shows("text:/more=/")).toBe(false);
  await app.scroll("id:t", 3000);
  await app.waitFor("text:/more=1/");
  await app.wait(200);
  expect(app.shows("text:/more=2/")).toBe(false);
});

test("the ref selects, scrolls, sizes, fits, reads and copies", async () => {
  const app = await start();
  await app.press("select-3");
  await app.press("read");
  await app.waitFor("text:/read=3:undefined rows 0-/");
  // `select` reports no change.
  expect(app.shows("text:/sel=/")).toBe(false);
  await app.press("copy");
  expect(app.clipboard()).toBe("4\tPerson 3\tCairo\t-3\tnote 3");
  await app.press("to-row-50");
  await app.waitFor("Person 50");
  await app.waitFor("text:/rows=50-5\\d/");
  await app.press("to-note");
  await app.press("read");
  await app.waitFor("text:/read=3:undefined rows 50-5\\d cols \\d-5/");
  await app.press("set-width");
  await app.press("widths");
  await app.waitFor("text:/widths=60,200,90,90,120/");
  // Setting a width from the app reports no resize.
  expect(app.shows("text:/resize=/")).toBe(false);
  await app.press("fit");
  await app.waitFor("text:/fit=\\d+/");
  await app.press("dump");
  await app.waitFor(
    "text:/dump=ID\\|Name\\|City\\|Change\\|Note \\/ 1\\|Person 0\\|Oslo\\|0\\|note 0 \\/ 2\\|Person 1\\|Lima\\|10\\|note 1$/",
  );
});

test("a column's classes style its titles and cells, by the value's sign", async () => {
  const app = await start();
  expect(app.spanStyle("text:City").underline).toBe(true);
  expect(app.spanStyle("text:Name").underline).toBe(false);
  expect(app.spanStyle("text:Oslo >> nth=0").italic).toBe(true);
  expect(app.spanStyle("text:Person 0").italic).toBe(false);
  // text-red-600 and text-green-600.
  expect(app.spanStyle("text:-3").color).toBe("#e7000bff");
  expect(app.spanStyle("text:40").color).toBe("#00a63eff");
  // An unclassified value inherits the parent's color, rather than a
  // component-owned theme color (this fixture uses the core's black).
  expect(app.spanStyle("text:/^0$/").color).toBe("#000000ff");
  expect(app.shows("Who")).toBe(true);
  expect(app.shows("Numbers")).toBe(true);
});

test("screen readers get a grid of column headers and cells, selected ones said so", async () => {
  const app = await start();
  expect(app.count("role:grid[People]")).toBe(1);
  expect(app.shows("role:columnheader[City]")).toBe(true);
  expect(app.shows("role:cell[Person 3]")).toBe(true);
  // A press reports itself, whatever it selects.
  await app.press("rows");
  await app.press("text:Person 4");
  await app.waitFor("text:/press=4:1:1/");
  expect(app.shows("text:/sel=/")).toBe(false);
});

test("the desktops' horizontal bar shows while the columns overflow, unless turned off", async () => {
  const app = await start();
  expect(app.shows("id:data-table-scrollbar")).toBe(true);
  // The vertical bar alone off leaves the horizontal one.
  await app.press("no-vbar");
  await app.wait(100);
  expect(app.shows("id:data-table-scrollbar")).toBe(true);
  await app.press("no-hbar");
  await app.wait(100);
  expect(app.shows("id:data-table-scrollbar")).toBe(false);
});

test("rowClasses give rows their own look, following the data", async () => {
  const app = await start();
  // ID 5 (Person 4) is struck through; its neighbors are not.
  expect(app.spanStyle("text:Person 4").lineThrough).toBe(true);
  expect(app.spanStyle("text:Person 3").lineThrough).toBe(false);
  // Sorted the other way, the classes follow their rows.
  await app.press("id:sort:id");
  await app.press("id:sort:id");
  await app.waitFor("Person 59");
  expect(app.spanStyle("text:Person 59").lineThrough).toBe(true);
  expect(app.spanStyle("text:Person 58").lineThrough).toBe(false);
});
