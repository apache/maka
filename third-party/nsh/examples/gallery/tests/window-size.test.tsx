// `windowSize()` and the size classes follow the window the user sees and
// resizes, not the desktops' hidden app host (on Windows, the app's primary
// window: the first of its own windows still open).
import { open, test } from "nsh/test";

test("windowSize follows the app's window as it is resized", async () => {
  const app = await open("./fixtures/window-size.tsx", { width: 900, height: 600 });
  if (!app.shows("OS: windows")) return;
  await app.waitFor("text:size=900x600");
  await app.waitFor("text:class=regular");
  await app.setViewport(420, 640);
  await app.waitFor("text:size=420x640");
  await app.waitFor("text:class=compact");
});
