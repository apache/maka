// The gallery names no update source: checking answers that there is none.
import { open, test } from "nsh/test";

test("an app without a source has no update", async () => {
  const app = await open("../App.tsx", { clock: {} });
  await app.press("role:button[Updater]");
  await app.waitFor("Not checked yet");
  await app.press("role:button[Check for updates]");
  await app.waitFor("No update available");
});
