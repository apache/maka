import { expect, open, test } from "nsh/test";

// Reproduces the financial chart popup defect: a dialog unmounted on close
// and mounted again on reopen stops delivering JS touch gestures (the
// chart's PanResponder and raw onTouch, which go through the modal's
// TouchTracker) the second time, while plain onPress buttons (a separate
// PressRecognizer per view) keep working. The first presentation's gestures
// reach JS; the reopened one's must too.
test("a reopened dialog still delivers chart gestures (PanResponder / onTouch) to JS", async () => {
  const app = await open("./App.tsx");
  const num = (prefix: string) => {
    const t = app.texts().find((s) => s.startsWith(prefix));
    return t ? parseInt(t.slice(prefix.length), 10) || 0 : 0;
  };

  await app.press("Open chart popup");
  await app.waitFor("Chart popup");

  // First presentation: raw touch and the chart's pan both reach JS.
  await app.drag("id:touchpad", { x: 0, y: 40 });
  await app.waitUntil(() => num("touchN:") > 0);
  await app.drag("id:chart", { x: -80, y: 0 });
  await app.waitUntil(() => num("chartDx:") !== 0);
  const touchesBefore = num("touchN:");

  // Close all the way, let the dismissal finish, then present a fresh one.
  await app.press("Close");
  await app.waitFor("text:open: false");
  await app.wait(600);
  await app.press("Open chart popup");
  await app.waitFor("Chart popup");

  // The button (PressRecognizer) still works after reopen.
  await app.press("Button (onPress) — should still work");
  await app.waitUntil(() => num("tapN:") > 0);

  // The reopened dialog's chart gestures must reach JS the same way.
  await app.drag("id:touchpad", { x: 0, y: 40 });
  await app.waitUntil(() => num("touchN:") > touchesBefore);
});
