// Driven by `jank.py`, which reads the marks (`@@jank`) and the performance monitor's line of every second
// (`--fps`). Run alone it is a smoke test of the app on a desktop host.
import { open, test } from "nsh/test";

const SECONDS = Number(process.env.JANK_SECONDS ?? 4);
const mark = (name: string) => console.log(`@@jank ${name}`);

test(
  "jank",
  async () => {
    const start = Date.now();
    const app = await open("./App.tsx", { width: 800, height: 600 });
    await app.waitFor("Row 0");
    // The app's launch to its window on screen with the first rows: `open` waits for the window to show (a window
    // kept hidden for its first frame counts as opening) and for the app to settle.
    mark(`startup ${Date.now() - start}`);

    mark("animation");
    await app.wait(SECONDS * 1000);

    mark("scroll");
    const end = Date.now() + SECONDS * 1000;
    let down = true;
    while (Date.now() < end) {
      // A row in the middle of the window, in the list that holds it (the scroll lands on the List under it).
      const row = app.texts().find((t) => /^Row \d+$/.test(t) && app.shows(t)) ?? "Row 0";
      await app.scroll(`text:${row}`, down ? 3_000 : -3_000);
      down = !down;
    }
    mark("-");
    await app.wait(1_200);
  },
  120_000,
);
