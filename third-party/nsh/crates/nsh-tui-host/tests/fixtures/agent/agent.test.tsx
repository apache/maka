import { expect, open, test } from "nsh/test";

test("terminal screenshots capture styled Cells after real pointer input", async () => {
  const app = await open("./App.tsx", { width: 160, height: 64 });
  await app.press("id:increment");
  await app.waitFor("Count 1");
  const bytes = await app.screenshot();
  const picture = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes)));
  expect(picture.format).toBe("nsh-tui-cells");
  expect(picture.version).toBe(1);
  expect(picture.width).toBe(20);
  expect(picture.height).toBe(4);
  expect(picture.rows.length).toBe(4);
  expect(picture.rows.every((row: unknown[]) => row.length === 20)).toBe(true);
  expect(picture.rows[0][0]).toEqual({
    symbol: "界", fg: "blue", bg: "reset", underline: "reset", modifiers: ["bold", "italic", "underlined"],
  });
  expect(picture.rows[0][2].symbol).toBe("A");
  const shown = picture.rows.map((row: { symbol: string }[]) => row.map(cell => cell.symbol).join(""));
  expect(shown.some((row: string) => row.includes("Count 1"))).toBe(true);
  expect(Array.from(await app.screenshot())).toEqual(Array.from(bytes));
});

test("terminal startup reports app errors through the test agent", async () => {
  await expect(() => open("./error.tsx")).rejects.toThrow("terminal startup failure");
});

test("terminal mouse presses reveal mounted controls below and above the scroll viewport", async () => {
  const app = await open("./Scroll.tsx", { width: 320, height: 160 });
  const picture = JSON.parse(new TextDecoder().decode(new Uint8Array(await app.screenshot())));
  const shown = picture.rows.map((row: { symbol: string }[]) => row.map(cell => cell.symbol).join("")).join("\n");
  expect(app.texts()).toContain("Team");
  expect(shown.includes("Team")).toBe(false);
  await app.press("Team");
  await app.waitFor("Pressed: Team");
  await app.press("Start");
  await app.waitFor("Pressed: Start");
});
