// Dictation with `nsh-extra`'s `Speech`: the module's fake recognizer
// (`"nsh-extra/speech"`) listens at once in headless runs, the test speaks
// for the user through it (`app.fake(SPEECH, "hear", [text])`), and the
// app's `stop()` (or the fake's `end`) ends the session with the
// transcript as its final result.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

const SPEECH = "nsh-extra/speech";

let app: App;
const hear = (text: string) => app.fake(SPEECH, "hear", [text]);
const end = (error?: string) => app.fake(SPEECH, "end", error === undefined ? [] : [error]);

beforeEach(async () => {
  app = await open("../App.tsx");
  await app.press("label:Dictate");
  await app.waitFor("text:state: listening");
});

test("the transcript grows as the user speaks, and stopping finishes it", async () => {
  expect(await app.fake(SPEECH, "requests")).toEqual([{ lang: "zh-CN", interim: true }]);
  await hear("你好");
  await app.waitFor("text:transcript: 你好");
  await hear("你好世界");
  await app.waitFor("text:transcript: 你好世界");
  await app.press("label:Dictate");
  await app.waitFor("text:state: ended");
  expect(app.texts()).toContain("transcript: 你好世界");
});

test("a session that heard nothing ends with no-speech", async () => {
  await end();
  await app.waitFor("text:state: ended no-speech");
});

test("the recognizer's failure ends the session with its error", async () => {
  await hear("hel");
  await end("network");
  await app.waitFor("text:state: ended network");
});

test("aborting ends it at once, without an error", async () => {
  await hear("draft");
  await app.press("label:Cancel");
  await app.waitFor("text:state: ended");
  // The recognizer was told: nothing listens any more.
  await expect(() => hear("late")).rejects.toThrow("no speech session listens");
});
