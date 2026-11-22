import { open, test } from "nsh/test";

const desktop = { platform: "macos", width: 600, height: 500 } as const;

test("a column fixed at the end stays at the table's end while the others scroll", async () => {
  const app = await open("./fixtures/data-table-end.tsx", desktop);
  await app.waitFor("Name 0");
  // Columns are reported by their place in `columns`: Act is 3.
  await app.press("text:Act 2");
  await app.waitFor("text:log=2:3");
  await app.press("text:A 2");
  await app.waitFor("text:log=2:1");
  // Scrolled to the last column, Act is still where a press finds it.
  await app.press("to-d");
  await app.waitFor("D 4");
  await app.press("text:Act 4");
  await app.waitFor("text:log=4:3");
  await app.press("text:D 4");
  await app.waitFor("text:log=4:5");
  // Name, fixed at the start, too.
  await app.press("text:Name 5");
  await app.waitFor("text:log=5:0");
});
