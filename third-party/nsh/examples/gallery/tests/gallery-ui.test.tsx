// The gallery and website share these components and their theme.
import { expect, open, test } from "nsh/test";

const fixture = "../../nsh-gallery-ui/tests/App.tsx";

test("shared controls keep their behavior and react to the shared theme", async () => {
  const app = await open(fixture, { colorScheme: "light", width: 600, height: 900 });
  await app.waitFor("appearance light");
  expect(app.spanStyle("text:appearance light").color).toBe("#16171aff");
  await app.press("label:Pressed 0");
  await app.waitFor("Pressed 1");
  await app.press("label:Feature");
  await app.waitFor("Feature true");
  await app.press("Second");
  await app.waitFor("Selected second");
  expect(app.shows("Inside the shared inset")).toBe(true);
  await app.press("label:Change appearance");
  await app.waitFor("appearance dark");
  expect(app.spanStyle("text:appearance dark").color).toBe("#eceef1ff");
});
