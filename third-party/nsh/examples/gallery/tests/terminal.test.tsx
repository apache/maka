// The Terminal demo: `nsh/base`'s `Terminal` showing a small shell
// written in TypeScript. What is typed reaches the shell through
// `onData`, the keys with no text (Enter, Backspace, Ctrl+C) as a
// terminal sends them, and the shell's output is drawn with its colors.
import { expect, open, test } from "nsh/test";

test("the Terminal demo runs the commands typed into it", async () => {
  const app = await open("../App.tsx");
  await app.press("role:button[Terminal]");
  // The welcome waits for the first size, then the prompt.
  await app.waitFor("Welcome to the NSH terminal.");
  expect(app.shows("Commands:")).toBe(true);

  // Text typed is echoed by the shell; Enter runs it.
  await app.type("label:Terminal", "echo native shell");
  await app.waitFor("text:nsh:~$ echo native shell");
  await app.keyboard.press("enter");
  await app.waitFor("native shell");

  // Backspace takes back what was typed.
  await app.type("label:Terminal", "echo typo");
  await app.keyboard.press("backspace");
  await app.keyboard.press("backspace");
  await app.type("label:Terminal", "ped");
  await app.keyboard.press("enter");
  await app.waitFor("typed");

  // Ctrl+C drops the line being typed.
  await app.type("label:Terminal", "half a line");
  await app.keyboard.press("ctrl+c");
  await app.waitFor("text:nsh:~$ half a line^C");

  // A bar redrawn in place with `\r` ends as one line at 100%.
  await app.type("label:Terminal", "progress");
  await app.keyboard.press("enter");
  await app.waitFor("████████████████████ 100%");

  // `clear` empties the screen, the prompt back at its top.
  await app.type("label:Terminal", "clear");
  await app.keyboard.press("enter");
  await app.waitFor("Welcome to the NSH terminal.", { state: "gone" });
  await app.waitFor("text:nsh:~$");
});
