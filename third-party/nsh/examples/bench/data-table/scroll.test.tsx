// Opens the 100,000 × 20 DataTable scroll workload in a 1280 × 800 desktop
// viewport and drives steady vertical scrolls through `nsh/test`, verifying
// that `onVisibleRowsChange` advances past the initial 200-row page. Set
// `EXTERNAL_DRIVER=1` to hold the window open for 20 s for an outside driver
// (such as Xvfb + XTest dragging the scroll bar) while `--fps` logs.
import { type App, expect, open, test } from "nsh/test";

const desktopPlatform = (): "macos" | "windows" | "linux" => {
  if (
    process.platform === "macos" ||
    process.platform === "windows" ||
    process.platform === "linux"
  ) {
    return process.platform;
  }
  return "linux";
};

const firstVisibleRow = (app: App): number | null => {
  let min = Number.POSITIVE_INFINITY;
  for (const text of app.texts()) {
    if (/^#\d+$/.test(text)) {
      const index = Number(text.slice(1));
      if (index < min) min = index;
    }
  }
  return Number.isFinite(min) ? min : null;
};

// Each step advances ~100 rows (row height is 32 pt), crossing multiple
// 200-row `onVisibleRowsChange` pages across four steps.
const STEPS = 4;
const STEP_DISTANCE = 3_200;

test(
  "the DataTable scroll workload",
  async () => {
    const app = await open("./App.tsx", {
      platform: desktopPlatform(),
      width: 1280,
      height: 800,
    });
    await app.waitFor("#0");

    if (process.env.EXTERNAL_DRIVER === "1") {
      await app.wait(20_000);
      return;
    }

    const initial = firstVisibleRow(app);
    expect(initial).toBe(0);
    let previous = initial ?? 0;

    for (let step = 0; step < STEPS; step++) {
      await app.scroll("id:table", STEP_DISTANCE);
      let next: number | null = null;
      await app.waitUntil(() => {
        next = firstVisibleRow(app);
        return next !== null && next > previous;
      });
      previous = next ?? previous;
    }

    expect(previous).toBeGreaterThanOrEqual(200);
    expect(app.shows("#0")).toBe(false);
  },
  60_000,
);
