#!/usr/bin/env node
// Real desktop-chain test for Computer Use: the actual Maka app, a real model,
// and a real third-party application.
//
// Everything before this drove the backend directly from a bare node process.
// That proves the protocol and the host, and nothing about the chain a person
// actually uses: the renderer's composer, the tool surface assembled in
// `tool-assembly.ts`, the approval gate, the cursor overlay, the status item
// and the picture-in-picture mirror. Those only exist inside the app.
//
// Target: Calculator. It is a real Apple application rather than a fixture, it
// has no documents, no network and no state worth keeping, and pressing its
// buttons is visible and reversible. Nothing here can send a message, save a
// file, or touch anything that matters.
//
// Run: npx playwright test is not involved. This is a plain script:
//   node scripts/cu-desktop-chain-real.mjs
import { _electron as electron } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'apps', 'desktop');
const OUT = '/tmp/cu-desktop-chain';

const TARGET_APP = process.env.CU_TARGET_APP ?? 'Calculator';
const TARGET_BUNDLE = process.env.CU_TARGET_BUNDLE ?? 'com.apple.calculator';
const PROMPT =
  process.env.CU_PROMPT ??
  `用 computer use 观察一下计算器这个应用的窗口，然后点一下里面的数字 7。只做这两步，做完就停。`;

let failures = 0;
const rows = [];
const check = (label, pass, detail) => {
  if (!pass) failures += 1;
  rows.push({ label, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
};
const note = (line) => console.log(`      ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function frontmostPid() {
  try {
    const { stdout } = await exec('osascript', [
      '-e',
      'tell application "System Events" to get unix id of first process whose frontmost is true',
    ]);
    return stdout.trim();
  } catch {
    return 'unavailable';
  }
}

async function pidOf(bundle) {
  try {
    const { stdout } = await exec('osascript', [
      '-e',
      `tell application "System Events" to get unix id of first process whose bundle identifier is "${bundle}"`,
    ]);
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Every BrowserWindow the main process currently holds, with what it is. */
async function windowInventory(app) {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({
      id: w.id,
      title: w.getTitle(),
      bounds: w.getBounds(),
      visible: w.isVisible(),
      alwaysOnTop: w.isAlwaysOnTop(),
      focused: w.isFocused(),
      parentId: w.getParentWindow()?.id ?? null,
      url: w.webContents.getURL().split('/').pop() ?? '',
    })),
  );
}

await mkdir(OUT, { recursive: true });

// Rule out the one piece of machine state that changes every accessibility
// tree at once, before anything else runs.
//
// With the screen locked the window server stops exposing window contents, so
// every app observes as its menu bar and nothing else — a tree indistinguishable
// from an app that genuinely has no controls. Read that way it cost most of an
// afternoon and one pull request built on the wrong diagnosis. It is one
// syscall to rule out, so it is ruled out first.
{
  const probe = join(await mkdtemp(join(tmpdir(), 'cu-lock-')), 'probe.swift');
  await writeFile(
    probe,
    'import CoreGraphics\nimport Foundation\n' +
      'let d = CGSessionCopyCurrentDictionary() as? [String: Any]\n' +
      'print((d?["CGSSessionScreenIsLocked"] as? Int) == 1 ? "locked" : "unlocked")\n',
    'utf8',
  );
  const { stdout } = await exec('swift', [probe], { timeout: 90_000 }).catch(() => ({
    stdout: '',
  }));
  if (stdout.trim() === 'locked') {
    console.log(
      'the screen is locked. Computer Use refuses to observe a locked screen, and an\n' +
        'unguarded observation returns a menu-only tree that reads like an app with no\n' +
        'controls. Unlock and re-run.',
    );
    process.exit(2);
  }
}

// The target must be running and in the background before anything starts:
// Computer Use exists to drive what the user is not looking at.
await exec('open', ['-g', '-a', TARGET_APP]).catch(() => {});
await sleep(1500);
const targetPid = await pidOf(TARGET_BUNDLE);
if (!targetPid) {
  console.log(`${TARGET_APP} did not start; stopping.`);
  process.exit(2);
}
console.log(`target ${TARGET_APP} pid=${targetPid}\n`);

const app = await electron.launch({ args: ['.'], cwd: DESKTOP });
const mainLogs = [];
app.on('console', (m) => mainLogs.push(m.text()));

try {
  const page = await app.firstWindow();
  page.on('console', (m) => {
    if (m.type() === 'error') mainLogs.push(`[renderer] ${m.text()}`);
  });
  await page.waitForSelector('.maka-composer-textarea', { timeout: 45_000 });
  await sleep(1500);
  check('the desktop app starts and reaches the composer', true);

  const beforeWindows = await windowInventory(app);
  note(`windows at rest: ${beforeWindows.map((w) => `${w.id}:${w.url}`).join(', ')}`);

  const beforeFrontmost = await frontmostPid();
  check(
    'the target is in the background before the run',
    beforeFrontmost !== targetPid,
    `frontmost ${beforeFrontmost}, target ${targetPid}`,
  );

  // A new conversation, so the transcript this reads belongs to this run and
  // the model is not answering with the tail of somebody else's turn.
  const newTask = page.getByRole('button', { name: '新任务' });
  if (await newTask.count()) {
    await newTask.first().click();
    await sleep(1200);
  }

  // Ask for a real Computer Use turn, through the composer, like a person.
  await page.click('.maka-composer-textarea');
  await page.fill('.maka-composer-textarea', PROMPT);
  await page.keyboard.press('Enter');
  console.log(`\nsent: ${PROMPT}\n`);

  // Watch the main process while the turn runs: the mirror and the overlay are
  // windows, and their appearance is the display half of this test.
  const seen = new Map();
  let sawPip = false;
  let sawOverlay = false;
  // The composer swaps its send button for a stop button while a turn streams,
  // and the stop button's accessible name is stable — which is the point of the
  // accessibility rule that a control names what it does. It is the only signal
  // here that says "still working" without polling the model.
  const stopButton = page.getByRole('button', { name: '停止' });

  let sampleErrors = 0;
  const sample = async () => {
    // One failed evaluate must not end the observation. The main-process
    // context can refuse a call while it is busy creating a window — which is
    // precisely the moment this is watching for.
    let now;
    try {
      now = await windowInventory(app);
    } catch {
      sampleErrors += 1;
      return;
    }
    for (const w of now) {
      if (!seen.has(w.id)) {
        note(
          `window appeared: ${w.id} ${w.url || '(loading)'} ${JSON.stringify(w.bounds)} parent=${w.parentId} onTop=${w.alwaysOnTop} focused=${w.focused}`,
        );
      }
      // Keep the latest state, not the first. A window's URL is empty on the
      // sample that catches it being created, and identifying it by that empty
      // string is how the mirror's own assertions got skipped while the mirror
      // was plainly on screen.
      seen.set(w.id, { ...(seen.get(w.id) ?? {}), ...w, url: w.url || seen.get(w.id)?.url || '' });
    }
    for (const w of seen.values()) {
      if (w.url.startsWith('pip')) sawPip = true;
      if (w.url.startsWith('cursor-overlay')) sawOverlay = true;
    }
  };

  // Wait for the turn to start, then for it to finish. Sampling throughout,
  // because the mirror and the overlay come and go inside the turn.
  let started = false;
  const startBy = Date.now() + 45_000;
  while (Date.now() < startBy) {
    await sample();
    if ((await stopButton.count().catch(() => 0)) > 0) {
      started = true;
      break;
    }
    await sleep(400);
  }
  check(
    'the turn started',
    started,
    started ? '' : 'the composer never entered the streaming state',
  );

  const endBy = Date.now() + 240_000;
  while (started && Date.now() < endBy) {
    await sample();
    if ((await stopButton.count().catch(() => 0)) === 0) break;
    await sleep(400);
  }
  await sample();
  if (sampleErrors) note(`${sampleErrors} window samples were refused mid-turn`);

  const duringFrontmost = await frontmostPid();
  check(
    'driving in the background never brought the target forward',
    duringFrontmost !== targetPid,
    `frontmost ${duringFrontmost}, target ${targetPid}`,
  );

  const pip = [...seen.values()].find((w) => w.url.startsWith('pip'));
  check(
    'the picture-in-picture mirror opened',
    sawPip,
    pip ? JSON.stringify(pip.bounds) : 'never appeared',
  );
  if (pip) {
    check('the mirror is the app window’s child', pip.parentId !== null, `parent=${pip.parentId}`);
    check('the mirror does not float above other apps', pip.alwaysOnTop === false);
    check('the mirror never took focus', pip.focused === false);
    check(
      'the mirror is Codex-sized',
      Math.max(pip.bounds.width, pip.bounds.height) <= 400 &&
        Math.max(pip.bounds.width, pip.bounds.height) >= 100,
      `${pip.bounds.width}x${pip.bounds.height}`,
    );
  }
  check('the agent cursor overlay opened', sawOverlay, sawOverlay ? '' : 'never appeared');

  // What the conversation actually says, so a green run cannot mean "nothing
  // happened quietly".
  const transcript = await page
    .locator('.maka-chat-turn, [class*="turn"]')
    .allInnerTexts()
    .catch(() => []);
  const text = transcript.join('\n');
  check(
    'the turn produced a Computer Use tool call',
    /Maka Computer|computer/i.test(text),
    text.slice(-260),
  );
  // A failed tool call inside a turn that recovered is not a failed turn — but
  // it is worth naming, because a model that has to guess twice is a model the
  // tool surface told something unhelpful the first time.
  const failedCalls = (text.match(/(\d+) 个失败/g) ?? []).join(', ');
  if (failedCalls) note(`tool calls reported failed: ${failedCalls}`);
  check(
    'the turn ended with a result rather than an error',
    /完成|成功|✅/.test(text.slice(-400)) && !/工具调用失败/.test(text.slice(-400)),
    text.slice(-200).replace(/\n+/g, ' '),
  );

  await page.screenshot({ path: join(OUT, 'app.png') }).catch(() => {});
  await writeFile(join(OUT, 'transcript.txt'), text, 'utf8');
  await writeFile(join(OUT, 'main-logs.txt'), mainLogs.join('\n'), 'utf8');
  note(`evidence in ${OUT}`);
} catch (error) {
  failures += 1;
  console.log(`\n[ERROR] ${error?.stack ?? error?.message ?? error}`);
  await writeFile(join(OUT, 'main-logs.txt'), mainLogs.join('\n'), 'utf8').catch(() => {});
} finally {
  await app.close().catch(() => {});
}

console.log(
  `\n${rows.filter((r) => r.pass).length}/${rows.length} checks passed` +
    (failures === 0 ? ' — DESKTOP CHAIN OK' : ''),
);
process.exit(failures === 0 ? 0 : 1);
