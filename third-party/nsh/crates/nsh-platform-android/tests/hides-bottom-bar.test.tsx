// Run with --target android: hidesBottomBarWhenPushed hides the Android TabBar while any
// page in the visible stack requests it, without letting hidden stacks take over.
import { open, test } from "nsh/test";

test("hidesBottomBarWhenPushed hides the Android TabBar for pushed pages and restores it on pop", async () => {
  const app = await open("./HidesBottomBar.tsx");
  // Hidden second stack has a hidesBottomBarWhenPushed page, but the visible stack is at root:
  // the bar stays shown and tapping bottom-right hits Stats.
  await app.waitFor("tab=0 selected=0 hits=0 depth=1");
  await app.press("id:tap-tab-stats");
  await app.waitFor("tab=0 selected=1 hits=0 depth=1");

  // Push a hiding page: the bar hides and a button behind the bottom strip becomes pressable.
  await app.press("id:push-hiding");
  await app.waitFor("tab=0 selected=1 hits=0 depth=2");
  await app.press("id:bottom-right");
  await app.waitFor("tab=0 selected=1 hits=1 depth=2");

  // Push another page without hidesBottomBarWhenPushed: the bar remains hidden (UIKit rule).
  await app.press("id:push-nested");
  await app.waitFor("tab=0 selected=1 hits=1 depth=3");
  await app.press("id:bottom-right-nested");
  await app.waitFor("tab=0 selected=1 hits=2 depth=3");

  // Pop back to root: the bar comes back and tapping the left tab selects Records (0).
  await app.press("id:pop-to-root");
  await app.waitFor("tab=0 selected=1 hits=2 depth=1");
  await app.press("id:tap-tab-records");
  await app.waitFor("tab=0 selected=0 hits=2 depth=1");

  // Switch to the second retained stack whose pushed screen has hidesBottomBarWhenPushed:
  // the bar hides again when that stack becomes visible.
  await app.press("id:switch-tab-1");
  await app.waitFor("tab=1 selected=0 hits=2 second=2");
  await app.press("id:bottom-right-second");
  await app.waitFor("tab=1 selected=0 hits=3 second=2");
});
