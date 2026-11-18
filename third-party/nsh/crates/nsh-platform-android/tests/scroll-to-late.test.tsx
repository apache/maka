// Run with --target android: HorizontalScrollView clamps a scroll to its content.
import { open, test } from "nsh/test";

test("an initial contentOffset waits for pages that arrive later", async () => {
  const app = await open("./ScrollToLate.tsx");
  await app.press("id:show-late");
  await app.waitFor("end=300");
});

test("a scrollTo while the pages are gone lands once they are back", async () => {
  const app = await open("./ScrollToLate.tsx");
  await app.press("id:show");
  await app.waitFor("end=300");
  await app.press("id:empty");
  await app.waitFor("end=0");
  await app.press("id:second");
  await app.press("id:fill");
  await app.waitFor("end=300");
});
