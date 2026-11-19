// A multiline input that a paste grows to its maximum height shows the
// line its caret is on: the text scrolls to the caret, as it does while
// the user types. Headless, and on macOS (`nsh test --target macos`).
import { expect, open, test } from "nsh/test";

const desktop = { width: 600, height: 600, platform: "macos" } as const;

test("a paste that grows a multiline input to its maximum height scrolls its caret into view", async () => {
  const app = await open("./fixtures/input-caret-grow.tsx", desktop);
  const read = (label: string) => app.texts().find((t) => t.startsWith(`${label} `))!.slice(label.length + 1);
  await app.waitUntil(() => Number(read("Height")) > 0);
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  await app.paste("id:composer", { text: `${lines}\nthe end` });
  await app.waitUntil(() => read("Height") === "120");
  // The caret's line, in the input's border box: inside its 120 points.
  await app.waitUntil(() => {
    const [y, h] = read("Caret").split(" ").map(Number);
    return y >= 0 && y + h <= 120;
  });
  expect(read("Height")).toBe("120");
});
