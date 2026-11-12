import { type App, expect, open, test } from "nsh/test";

// The editor's padding (10 above and below) and the border around it (1 each side).
const CHROME = 22;

const height = (app: App) => Number(app.texts().find((t) => t.startsWith("Height "))!.slice(7));

/** Types each line into the composer after the one before. */
async function addLines(app: App, lines: string[]) {
  for (const line of lines) {
    await app.keyboard.press("enter");
    await app.type("id:composer", line);
  }
  await app.waitFor(lines[lines.length - 1]);
}

test("an editor without a height grows with its lines, up to its max-height", async () => {
  const app = await open("./fixtures/rich-editor-height.tsx");
  await app.press("text:First");
  await app.keyboard.press("end");
  const line = height(app) - CHROME;
  expect(line).toBeGreaterThan(0);
  await addLines(app, ["Second", "Third"]);
  expect(Math.abs(height(app) - CHROME - 3 * line)).toBeLessThanOrEqual(1);
  // Past 120 points it stops growing (and scrolls).
  await addLines(app, ["L4", "L5", "L6", "L7", "L8", "L9", "L10"]);
  expect(height(app)).toBe(120 + 2);
});
