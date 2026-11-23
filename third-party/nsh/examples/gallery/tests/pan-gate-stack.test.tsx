// A view with a `panActivation` whose pan is off (no `onPanStart`, no pan
// values) leaves the drags to its content: a stack inside swipes back from
// the middle of its page (iOS 26's content swipe). With the pan on, the
// view's pan takes the drag instead. Run with --target ios.
import { expect, open, test } from "nsh/test";

const FIXTURE = "./fixtures/pan-gate-stack.tsx";

// Opens the fixture in an iOS simulator, else nothing: headless runs take
// `host.handlers`, which a real platform rejects
// (`ERR_NSH_TEST_UNSUPPORTED`); the fixture calls none.
async function onIos() {
  try {
    await open(FIXTURE, { host: { handlers: { unused: null } } });
    return null;
  } catch (err) {
    if ((err as { code?: string }).code !== "ERR_NSH_TEST_UNSUPPORTED") throw err;
  }
  const app = await open(FIXTURE);
  await app.waitFor("text:Push");
  return app.shows("Platform: ios") ? app : null;
}

type App = NonNullable<Awaited<ReturnType<typeof onIos>>>;

async function pushAndSwipe(app: App) {
  await app.press("id:push");
  await app.waitFor("text:page: second, depth 2");
  // The push's transition ends before the swipe.
  await app.wait(800);
  await app.drag("id:content", { x: 260, y: 0 });
  await app.wait(1000);
}

test("a drag right on a page swipes back through a view whose pan is off", async () => {
  const app = await onIos();
  if (!app) return;
  await pushAndSwipe(app);
  await app.waitFor("text:page: root, depth 1");
}, 60_000);

test("a drag right on a page pans the view around it when its pan is on", async () => {
  const app = await onIos();
  if (!app) return;
  await app.press("id:toggle");
  await app.waitFor("text:drawer pan: on, 0 pans");
  await pushAndSwipe(app);
  await app.waitFor("text:drawer pan: on, 1 pans");
  expect(app.texts()).toContain("page: second, depth 2");
}, 60_000);

test("turning the pan off again gives the drags back to the stack", async () => {
  const app = await onIos();
  if (!app) return;
  await app.press("id:toggle");
  await app.waitFor("text:drawer pan: on, 0 pans");
  await app.press("id:toggle");
  await app.waitFor("text:drawer pan: off, 0 pans");
  await pushAndSwipe(app);
  await app.waitFor("text:page: root, depth 1");
}, 60_000);
