// The Sound demo and the gallery's sounds: loaded once as the app starts,
// played where a change completes (a row of the library, a switch a little
// lower turning off, a toast by its kind).
import { beforeEach, expect, open, test } from "nsh/test";
import type { App } from "nsh/test";

let app: App;
beforeEach(async () => {
  app = await open("../App.tsx");
  await app.setViewport(390, 1800);
  await app.press("role:button[Sound]");
  await app.waitFor("A notice that asks for the user");
});

/** The plays the app asked for, as `name volume rate`. */
const plays = () =>
  app
    .audio()
    .filter((c) => c.command === "play")
    .map((c) => `${c.src?.replace(/^.*\//, "")} ${c.volume} ${c.rate}`);

test("the sounds load once, before anything plays", () => {
  const loads = app.audio().filter((c) => c.command === "load").map((c) => c.src);
  const names = ["attention", "close", "error", "open", "ready", "select", "success", "tap", "toggle", "warning"];
  expect(loads.sort()).toEqual(names.map((n) => `asset:/sounds/${n}.wav`));
  expect(plays()).toEqual([]);
});

test("a row of the library plays its sound", async () => {
  await app.press("label:Play tap");
  expect(plays()).toEqual(["tap.wav 0.6 1"]);
});

test("a switch sounds lower turning off than on", async () => {
  await app.press("role:switch[Sounds]");
  await app.press("role:switch[Sounds]");
  expect(plays()).toEqual(["toggle.wav 0.6 0.9", "toggle.wav 0.6 1"]);
});

test("a toast sounds by its kind", async () => {
  await app.press("role:button[Save]");
  await app.press("role:button[Pay]");
  await app.press("role:button[Remind]");
  expect(plays()).toEqual(["success.wav 0.6 1", "error.wav 0.6 1", "attention.wav 0.6 1"]);
});

test("on a desktop, a demo picked in the sidebar sounds; the settings menu mutes it", async () => {
  await app.setViewport(1200, 900);
  await app.waitFor("label:Settings menu");
  await app.press("role:button[Text]");
  await app.press("role:button[Text]");
  await app.press("label:Settings menu");
  await app.press("role:menuitemcheckbox[Sounds]");
  await app.keyboard.press("escape");
  await app.press("role:button[Image]");
  await app.press("label:Settings menu");
  await app.press("role:menuitemcheckbox[Sounds]");
  await app.keyboard.press("escape");
  expect(plays()).toEqual(["select.wav 0.4 1", "toggle.wav 0.6 0.9", "toggle.wav 0.6 1"]);
});
