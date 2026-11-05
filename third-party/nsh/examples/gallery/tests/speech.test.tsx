// Dictation with `Speech`: the headless recognizer listens at once, the
// test speaks for the user (`app.hear`), and the app's `stop()` (or
// `app.endSpeech`) ends the session with the transcript as its final result.
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("./fixtures/speech.tsx");
  await app.press("label:Dictate");
  await app.waitFor("text:state: listening");
});

test("the transcript grows as the user speaks, and stopping finishes it", async () => {
  expect(app.speechRequests()).toEqual([{ lang: "zh-CN", interim: true }]);
  await app.hear("你好");
  await app.waitFor("text:transcript: 你好");
  await app.hear("你好世界");
  await app.waitFor("text:transcript: 你好世界");
  await app.press("label:Dictate");
  await app.waitFor("text:state: ended");
  expect(app.texts()).toContain("transcript: 你好世界");
});

test("a session that heard nothing ends with no-speech", async () => {
  await app.endSpeech();
  await app.waitFor("text:state: ended no-speech");
});

test("the recognizer's failure ends the session with its error", async () => {
  await app.hear("hel");
  await app.endSpeech("network");
  await app.waitFor("text:state: ended network");
});

test("aborting ends it at once, without an error", async () => {
  await app.hear("draft");
  await app.press("label:Cancel");
  await app.waitFor("text:state: ended");
  // The recognizer was told: nothing listens any more.
  await expect(() => app.hear("late")).rejects.toThrow("no speech session listens");
});
