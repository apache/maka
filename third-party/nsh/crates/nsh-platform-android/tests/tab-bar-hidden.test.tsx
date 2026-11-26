// Run with --target android: TabBar.hidden hides the bar and passes touches through.
import { open, test } from "nsh/test";

test("TabBar.hidden hides the Android bar and restores it when cleared", async () => {
  const app = await open("./TabBarHidden.tsx");
  await app.waitFor("hidden=true selected=0 hits=0");

  // Hidden on initial mount: pressing in the bottom strip hits the control beneath.
  await app.press("id:bottom-right");
  await app.waitFor("hidden=true selected=0 hits=1");

  // Show the bar: a press at the same bottom-right point hits the Stats tab instead.
  await app.press("id:toggle");
  await app.waitFor("hidden=false selected=0 hits=1");
  await app.press("id:bottom-right");
  await app.waitFor("hidden=false selected=1 hits=1");

  // Hide again: touches in the strip reach the underlying button once more.
  await app.press("id:toggle");
  await app.waitFor("hidden=true selected=1 hits=1");
  await app.press("id:bottom-right");
  await app.waitFor("hidden=true selected=1 hits=2");
});
