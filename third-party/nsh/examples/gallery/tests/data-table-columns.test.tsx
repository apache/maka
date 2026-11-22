// `DataTable`'s columns: a column's own classes, and a double press on its
// resize handle that fits it to its widest text.
import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 600, height: 400 } as const;

test("a double press on a resize handle fits its column", async () => {
  const app = await open("./fixtures/data-table-columns.tsx", desktop);
  await app.waitFor("Ada");
  await app.drag("id:resize:note", { x: 0, y: 0 });
  expect(app.shows("text:/widths note/")).toBe(false);
  await app.drag("id:resize:note", { x: 0, y: 0 });
  await app.waitFor("text:/widths note=\\d+/");
  expect(app.shows("widths note=80")).toBe(false);
});

test("a fit counts what the app's drawing adds to the text", async () => {
  const app = await open("./fixtures/data-table-columns.tsx", desktop);
  await app.waitFor("Ada");
  await app.drag("id:resize:note", { x: 0, y: 0 });
  await app.drag("id:resize:note", { x: 0, y: 0 });
  await app.waitFor("text:/widths note=\\d+/");
  const plain = Number(app.texts().find((t) => t.startsWith("widths"))!.split("=")[1]);
  await app.press("pad");
  await app.wait(600);
  await app.drag("id:resize:note", { x: 0, y: 0 });
  await app.drag("id:resize:note", { x: 0, y: 0 });
  await app.waitFor(`widths note=${plain + 40}`);
});
