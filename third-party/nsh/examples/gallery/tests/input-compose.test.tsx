// What an input method composes counts in a multiline input's height: a
// composition that wraps the line grows the input before it commits, as
// the text it commits will, and the value stays what was committed.
// Headless, and on macOS (`nsh test --target macos`).
import { expect, open, test } from "nsh/test";

const desktop = { width: 600, height: 500, platform: "macos" } as const;

test("a composition that wraps the line grows a multiline input before it commits", async () => {
  const app = await open("./fixtures/input-compose.tsx", desktop);
  const height = () => Number(app.texts().find((t) => t.startsWith("Height "))!.slice(7));
  await app.type("id:composer", "输入法");
  const line = height();
  // Pinyin for many characters: wider than the input.
  const pinyin = "zhongwenshurufadezuziwenbenyizhanglezhebuzuoyihangle";
  await app.compose("id:composer", pinyin);
  await app.waitFor(`text:Composing [${pinyin}]`);
  // The app's value is still what was committed (the platform's text
  // holds the marked text).
  expect(app.shows("text:Value [输入法]")).toBe(true);
  await app.waitUntil(() => height() > line);
  const wrapped = height();
  // Cancelled, it goes back to its line.
  await app.compose("id:composer", "");
  await app.waitFor("text:Composing []");
  await app.waitUntil(() => height() === line);
  // The same text in its value is as tall as it was composed.
  await app.paste("id:composer", { text: pinyin });
  await app.waitFor(`text:Value [输入法${pinyin}]`);
  await app.waitUntil(() => height() === wrapped);
});
