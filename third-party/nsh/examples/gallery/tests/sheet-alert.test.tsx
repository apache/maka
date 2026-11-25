// An alert shown in the press that closes a sheet is answered, whether the
// sheet goes with its own motion (`Sheet`) or the system's (a page sheet).
import { expect, open, test } from "nsh/test";

const FIXTURE = "./fixtures/sheet-alert.tsx";

// Long enough for the sheet's motion out to end.
const SETTLE = 1500;

// Presses "OK" once the sheet under the alert is gone.
const okLater = () => new Promise<string>((resolve) => setTimeout(() => resolve("OK"), SETTLE));

async function closeAndAsk(openLabel: string, inside: string, press: string) {
  const app = await open(FIXTURE);
  await app.press(`text:${openLabel}`);
  await app.waitFor(`text:${inside}`);
  await app.wait(SETTLE);
  app.onDialog(okLater);
  await app.press(`text:${press}`);
  await app.waitFor("text:answer: ok");
  expect(app.shows(`text:${inside}`)).toBe(false);
}

test("an alert shown as a sheet closes is answered", async () => {
  await closeAndAsk("Open sheet", "In the sheet", "Close sheet and ask");
});

test("an alert shown as a page sheet closes is answered", async () => {
  await closeAndAsk("Open page sheet", "In the page sheet", "Close page sheet and ask");
});

test("an alert shown just before a page sheet closes is answered", async () => {
  await closeAndAsk("Open page sheet", "In the page sheet", "Ask, then close page sheet");
});

test("an alert shown as a sheet opens is answered", async () => {
  const app = await open(FIXTURE);
  app.onDialog(okLater);
  await app.press("text:Open sheet and ask");
  await app.waitFor("text:answer: ok");
});
