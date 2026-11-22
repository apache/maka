import { expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

async function shownRows(app: App): Promise<string[]> {
  const picture = JSON.parse(new TextDecoder().decode(new Uint8Array(await app.screenshot())));
  return picture.rows.map((row: { symbol: string }[]) => row.map(cell => cell.symbol).join("").trimEnd());
}

test("C-s and C-r search the screen in the Minibuffer, which Enter removes at the match", async () => {
  const app = await open("./App.tsx", { width: 320, height: 160 });
  await app.waitFor("focus:none pressed:none");
  expect((await shownRows(app))[9]).toBe("footer");
  await app.keyboard.press("ctrl+s");
  for (const key of "row1") await app.keyboard.press(key);
  await app.waitFor("focus:1 pressed:none");
  expect((await shownRows(app))[9]).toBe("/row1");
  await app.keyboard.press("ctrl+s");
  await app.waitFor("focus:10 pressed:none");
  expect((await shownRows(app)).slice(1, 5)).toContain("row10");
  await app.keyboard.press("ctrl+r");
  await app.waitFor("focus:1 pressed:none");
  await app.keyboard.press("enter");
  expect((await shownRows(app))[9]).toBe("footer");
  await app.keyboard.press("enter");
  await app.waitFor("focus:1 pressed:1");
});
