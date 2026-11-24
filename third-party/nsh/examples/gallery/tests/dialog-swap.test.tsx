// A page sheet dialog closed and another opened in the same press: the new
// one stays open and takes presses, whichever comes first in the tree, and
// also when the old one leaves with the view it is in; the old one reports
// its close. Dialogs closed while another's dismissal runs report their
// close, and do not keep later ones from opening.
import { expect, open, test } from "nsh/test";

const FIXTURE = "./fixtures/dialog-swap.tsx";

// Long enough for the old sheet's dismissal to end, which took the new one
// along when it was presented over the old one.
const SETTLE = 1500;

// Opens the fixture, and whether it runs on a real platform (`--target`):
// headless dialogs report no close (`onClose`). Only headless runs take
// `host.handlers`, which a real platform rejects
// (`ERR_NSH_TEST_UNSUPPORTED`); the fixture calls none.
async function launch() {
  try {
    const app = await open(FIXTURE, { host: { handlers: { unused: null } } });
    return { app, native: false };
  } catch (err) {
    if ((err as { code?: string }).code !== "ERR_NSH_TEST_UNSUPPORTED") throw err;
    return { app: await open(FIXTURE), native: true };
  }
}

async function replace(from: string, press: string, to: string, old: string) {
  const { app, native } = await launch();
  await app.press(`text:${from}`);
  await app.waitFor(`text:${press}`);
  await app.press(`text:${press}`);
  await app.waitFor(`text:shown: ${to}`);
  await app.wait(SETTLE);
  const title = `${to[0].toUpperCase()}${to.slice(1)} sheet`;
  await app.press(`text:Count in ${title}`);
  await app.waitFor("text:count: 1");
  expect(app.texts()).toContain(`shown: ${to}`);
  if (native) expect(app.texts()).toContain(`closed: ${old}`);
}

test("a dialog written after the one it replaces stays open", async () => {
  await replace("Open first", "Replace with later", "later", "first");
});

test("a dialog written before the one it replaces stays open", async () => {
  await replace("Open first", "Replace with earlier", "earlier", "first");
});

test("a dialog replacing one closed with its view stays open", async () => {
  await replace("Open wrapped", "Replace wrapped with later", "later", "wrapped");
});

test("a dialog closed while the one under it leaves reports its close", async () => {
  const { app, native } = await launch();
  await app.press("text:Open base");
  await app.press("text:Open top");
  await app.press("text:Close base, then top");
  await app.waitFor("text:Open base");
  await app.wait(SETTLE);
  if (native) await app.waitFor("text:top: closed");
});

test("a dialog opens after one closed while the sheet over it leaves", async () => {
  const { app, native } = await launch();
  await app.press("text:Open outer");
  await app.press("text:Open inner");
  await app.press("text:Close inner, then outer, then open later");
  await app.waitFor("text:shown: later");
  await app.wait(SETTLE);
  await app.press("text:Count in Later sheet");
  await app.waitFor("text:count: 1");
  expect(app.texts()).toContain("shown: later");
  if (native) expect(app.texts()).toContain("closed: inner, outer");
});
