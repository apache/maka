import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 600, height: 500 } as const;

test("a cell's own button takes the press on it, the rest of the row presses the row", async () => {
  const app = await open("./fixtures/data-table-cells.tsx", desktop);
  await app.waitFor("Person 0");
  // The button lies under the table's hit layer, as on the platforms.
  await app.press("id:copy-2");
  await app.waitFor("text:/log=copy 2$/");
  // Its cell, beside the button, and another column press the row.
  await app.press("text:Person 3");
  await app.waitFor("text:/log=copy 2,row 3:0$/");
  expect(app.texts().some((t) => t.includes("row 2"))).toBe(false);
});

test("a cell's own views hear the pointer come and go under the hit layer", async () => {
  const app = await open("./fixtures/data-table-cells.tsx", desktop);
  await app.waitFor("Person 0");
  await app.hover("id:copy-2");
  await app.waitFor("text:/log=enter 2$/");
  await app.hover("id:copy-4");
  await app.waitFor("text:/log=enter 2,leave 2,enter 4$/");
  await app.hover("text:Person 4");
  await app.waitFor("text:/log=enter 2,leave 2,enter 4,leave 4$/");
});
