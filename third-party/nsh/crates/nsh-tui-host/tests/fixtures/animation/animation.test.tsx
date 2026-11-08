import { expect, open, test } from "nsh/test";

test("native animation finishes through the terminal host and paints its final Cells", async () => {
  const app = await open("./App.tsx", { width: 320, height: 128 });
  await app.press("id:run");
  await app.waitFor("Finished 1");
  const picture = JSON.parse(new TextDecoder().decode(new Uint8Array(await app.screenshot())));
  expect(picture.format).toBe("nsh-tui-cells");
  expect(picture.rows[1][0].symbol).toBe(" ");
  expect(picture.rows[1][2].symbol).toBe("A");
  expect(picture.rows[1][2].fg).toBe("green");
  expect(picture.rows[2][0].symbol).toBe(" ");
  expect(picture.rows[2][2].symbol).toBe("⣿");
  expect(picture.rows[2][3].symbol).toBe("⣿");
  expect(picture.rows[2][2].fg).toBe("green");
  await app.press("id:again");
  await app.waitFor("Finished 2");
  expect(app.shows("Finished 2")).toBe(true);
});
