// A multiline input grows with its text up to its `maxHeight`, then stops
// and scrolls its text; the view around it, sized from its content, stops
// with it. Headless, and on macOS (`nsh test --target macos`).
import { expect, open, test } from "nsh/test";

const desktop = { width: 600, height: 900, platform: "macos" } as const;

test("a multiline input and the card around it stop growing at the input's maxHeight", async () => {
  const app = await open("./fixtures/input-max-height.tsx", desktop);
  const read = (label: string) => Number(app.texts().find((t) => t.startsWith(`${label} `))?.slice(label.length + 1) ?? 0);
  await app.waitUntil(() => read("Input") > 0);
  const line = read("Input");
  const padding = read("Card") - line;
  await app.paste("id:composer", { text: "a line that wraps more than once in a narrow card " });
  await app.waitUntil(() => read("Input") > line);
  expect(read("Input")).toBeLessThan(120);
  // Far more than fits: the input stops at 120, the card with it.
  await app.paste("id:composer", { text: "a long pasted log line ".repeat(200) });
  await app.waitUntil(() => read("Input") === 120);
  expect(read("Card")).toBe(120 + padding);
  // Back under it, both shrink again.
  await app.clear("id:composer");
  await app.waitUntil(() => read("Input") === line);
  expect(read("Card")).toBe(line + padding);
});
