import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("./fixtures/audio.tsx");
});

test("a sound loads ahead and plays at once, overlapping", async () => {
  await app.press("label:Load");
  await app.waitFor("text:sound: 0.25s");
  await app.press("label:Play");
  await app.waitFor("text:refused: RangeError");
  const calls = app.audio().filter(c => c.command !== "open");
  expect(calls.map(c => c.command)).toEqual(["load", "play"]);
  expect(calls[1].volume).toBe(0.5);
  expect(calls[1].rate).toBe(1);
});

test("a sound longer than five seconds is refused", async () => {
  await app.press("label:Load long");
  await app.waitFor("text:sound: failed ERR_NSH_QUOTA_EXCEEDED");
  expect(app.audio().map(c => c.command)).toEqual(["open", "load", "unload"]);
});

test("a player streams, seeks and ends; a time past what it can hold throws", async () => {
  expect(app.audio()).toEqual([
    { command: "open", src: "https://example.com/voice.m4a", volume: 0.8, rate: 1, position: null },
  ]);
  await app.press("label:Listen");
  await app.waitFor("text:player: playing 60");
  await app.press("label:Skip");
  await app.waitFor("text:refused: seek RangeError");
  await app.endAudio();
  await app.waitFor("text:player: ended at 60");
  expect(app.audio().map(c => c.command)).toEqual(["open", "resume", "seek"]);
});
