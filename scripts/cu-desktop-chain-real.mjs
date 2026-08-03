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
import { writeFile, mkdir, mkdtemp, cp } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'apps', 'desktop');
const OUT = '/tmp/cu-desktop-chain';

// Whether this prompt asks for an action at all. A turn that was told to look
// and report has no action to mirror and no cursor to move, so asserting the
// presentation surfaces for it is asserting the product does something wrong.
// Whether this turn is expected to dispatch anything, which is what the mirror
// and the cursor are evidence of.
//
// Three states, because two were not enough. A task the model is expected to
// refuse may or may not try something before it concludes it cannot: measured
// on save-pdf, one run read the menu and reported in three calls with no
// dispatch at all, and the next tried `cmd+p` first. Asserting either way turns
// a coin toss into a red check, and asserting "no mirror" would fail the run
// for the model doing more of its homework.
const ACTS = process.env.CU_EXPECT_ACTION === undefined || process.env.CU_EXPECT_ACTION === '1';
const MAY_ACT = process.env.CU_EXPECT_ACTION === 'maybe';
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

/**
 * The pid of whatever is in front, or null when the question cannot be asked.
 *
 * `null`, not the string 'unavailable'. Both background invariants below are
 * written as `!== targetPid`, and 'unavailable' is not equal to any pid, so
 * returning it made them hold unconditionally — the invariant the whole product
 * rests on passed exactly when the harness had lost the ability to check it. An
 * Automation TCC denial is the obvious way that happens, and it is silent.
 */
async function frontmostPid() {
  try {
    const { stdout } = await exec('osascript', [
      '-e',
      'tell application "System Events" to get unix id of first process whose frontmost is true',
    ]);
    const pid = stdout.trim();
    return pid === '' ? null : pid;
  } catch {
    return null;
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

// A separate user data directory when asked for. The default workspace is the
// developer's real one, and it can refuse to open on its own — a disk-identity
// check puts up a native "repair this workspace?" dialog before any window
// exists, and a harness has nobody to click it. That looked exactly like a
// startup regression: the app launched, the event loop idled, and no window
// ever arrived. Pointing somewhere else answers the question in one run.
const userDataDir = process.env.CU_USER_DATA_DIR;

// A workspace of its own still needs a model to talk to.
//
// Pointing at a fresh user-data directory answers the disk-identity dialog, and
// then the app opens with no provider configured: the composer renders hidden,
// `skills:listInvocable` fails with "等待配置默认模型", and the harness times out
// waiting for a textarea that is present and will never be shown. That reads as
// a Computer Use regression and is a missing API key.
//
// So copy the connection profile across — the same three files
// `cu-real-model-launcher.mjs` copies — and nothing else. No sessions, no
// memory, no projects: this run gets the developer's credentials and none of
// their history.
if (userDataDir) {
  const source = join(homedir(), 'Library', 'Application Support', 'Maka', 'workspaces', 'default');
  const target = join(userDataDir, 'workspaces', 'default');
  await mkdir(target, { recursive: true });
  for (const name of ['llm-connections.json', 'credentials.json', 'settings.json']) {
    await cp(join(source, name), join(target, name)).catch((error) => {
      console.log(`      could not copy ${name}: ${error.message}`);
    });
  }
}
const app = await electron.launch({
  args: userDataDir ? ['.', `--user-data-dir=${userDataDir}`] : ['.'],
  cwd: DESKTOP,
  // A cold Electron start on a loaded machine takes longer than the 30s default,
  // and a timeout here reads as "the app is broken" rather than "it was slow".
  timeout: 120_000,
});
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
    beforeFrontmost !== null && beforeFrontmost !== targetPid,
    beforeFrontmost === null
      ? 'the frontmost process could not be read — most likely an Automation permission denial'
      : `frontmost ${beforeFrontmost}, target ${targetPid}`,
  );

  // Every session that existed before this run, so the one this run creates can
  // be named afterwards. The turn's tool calls are read out of the session
  // record rather than off the screen — see the check further down for why.
  const sessionsBefore = new Set(
    await page.evaluate(async () => (await window.maka.sessions.list()).map((s) => s.id)),
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
  //
  // The interval is a real constraint, not a politeness. `window_action` is one
  // Accessibility attribute write and the whole action is over in a couple of
  // hundred milliseconds; at 400ms a sampler catches the overlay by luck. The
  // same window-arrange run passed 12/12 alone and failed
  // "the agent cursor overlay opened" inside a six-scenario sweep, with nothing
  // different about the product. Sample faster than the shortest action.
  const SAMPLE_MS = 120;
  let started = false;
  const startBy = Date.now() + 45_000;
  while (Date.now() < startBy) {
    await sample();
    if ((await stopButton.count().catch(() => 0)) > 0) {
      started = true;
      break;
    }
    await sleep(SAMPLE_MS);
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
    await sleep(SAMPLE_MS);
  }
  await sample();
  if (sampleErrors) note(`${sampleErrors} window samples were refused mid-turn`);

  const duringFrontmost = await frontmostPid();
  check(
    'driving in the background never brought the target forward',
    duringFrontmost !== null && duringFrontmost !== targetPid,
    duringFrontmost === null
      ? 'the frontmost process could not be read, so this was not checked'
      : `frontmost ${duringFrontmost}, target ${targetPid}`,
  );

  // Every window this turn ever showed, not just the one being asserted on.
  // "the mirror never appeared" is the same output whether it was never opened
  // or opened under a url this check does not recognise, and the two have very
  // different fixes.
  note(`windows seen this turn: ${[...seen.values()].map((w) => `${w.id}:${w.url}`).join(', ')}`);
  const pip = [...seen.values()].find((w) => w.url.startsWith('pip'));
  if (ACTS) {
    check(
      'the picture-in-picture mirror opened',
      sawPip,
      pip ? JSON.stringify(pip.bounds) : 'never appeared',
    );
  } else if (MAY_ACT) {
    note(`mirror ${sawPip ? 'opened' : 'never appeared'} on a turn that might not act`);
  } else {
    // The mirror shows the frame an action produced. A read-only turn produces
    // none, so its absence is correct and its presence would be the bug.
    check(
      'no mirror for a turn that only looked',
      !sawPip,
      sawPip ? 'a mirror appeared for a read-only turn' : '',
    );
  }
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
  if (ACTS) {
    check('the agent cursor overlay opened', sawOverlay, sawOverlay ? '' : 'never appeared');
  } else if (MAY_ACT) {
    note(`cursor overlay ${sawOverlay ? 'opened' : 'never appeared'}`);
  }

  // The tool calls, read out of the session record.
  //
  // This used to regex `/Maka Computer|computer/i` over
  // `.maka-chat-turn, [class*="turn"]`. Two things were wrong with that.
  // `.maka-chat-turn` matches nothing in the product — the class is
  // `maka-turn`. And `[class*="turn"]` matches `section.maka-turn`, which
  // renders `turn.user.text`, so the haystack included the prompt this file
  // sent. Every prompt here begins 用 computer use, so the check passed on the
  // echo of its own request: withhold the Computer Use tool surface entirely,
  // let the model reply in prose with no tool call at all, and it still printed
  // PASS. The same inclusion also fed the empty-text guard below, which could
  // never see an empty transcript while the prompt was in it.
  //
  // The session record has no such ambiguity. A `tool_call` message is one the
  // model made.
  const sessionId = await page.evaluate(
    async (before) => {
      const now = await window.maka.sessions.list();
      const fresh = now.filter((s) => !before.includes(s.id));
      return fresh.length === 1 ? fresh[0].id : null;
    },
    [...sessionsBefore],
  );
  check(
    'this run got a conversation of its own to read',
    sessionId !== null,
    sessionId ?? 'no single new session appeared, so the transcript below is not attributable',
  );
  const messages = sessionId
    ? await page.evaluate((id) => window.maka.sessions.readMessages(id), sessionId)
    : [];
  const toolCalls = messages.filter((m) => m.type === 'tool_call');
  const computerCalls = toolCalls.filter((m) => m.toolName === 'maka_computer');
  check(
    'the turn produced a Computer Use tool call',
    computerCalls.length > 0,
    `${computerCalls.length} of ${toolCalls.length} tool calls were maka_computer` +
      (toolCalls.length > 0
        ? ` — ${[...new Set(toolCalls.map((m) => m.toolName))].join(', ')}`
        : ''),
  );
  // What the assistant said, with the user's own words left out of it, so the
  // breakdown check below reads the answer rather than the question.
  const text = messages
    .filter((m) => m.type === 'assistant')
    .map((m) => m.text ?? '')
    .join('\n');
  const results = new Map(
    messages.filter((m) => m.type === 'tool_result').map((m) => [m.toolUseId, m]),
  );
  // A failed tool call inside a turn that recovered is not a failed turn — but
  // it is worth naming, because a model that has to guess twice is a model the
  // tool surface told something unhelpful the first time.
  const failedCalls = computerCalls.filter((m) => results.get(m.id)?.isError === true).length;
  if (failedCalls) note(`tool calls that came back an error: ${failedCalls}`);
  // One line the parent can read, because the parent had been counting these
  // off a piece of interface copy — 操作电脑 N 次 — that does not exist in the
  // product, so every call-count cell in its table was a constant zero. The
  // number is known here; it is printed here.
  console.log(`computer-calls: ${computerCalls.length} failed: ${failedCalls}`);
  // What the turn ended as, not what words it used. The old test looked for
  // 完成/成功/✅ in the tail, so a model that answered a read-only question
  // perfectly — "I only observed, I clicked nothing" — was recorded as an
  // error. It was measuring phrasing.
  const tail = text.slice(-600);
  const brokeDown =
    /工具调用失败|Error:|error occurred|无法继续|抱歉[，,].*(失败|错误)/i.test(tail) ||
    text.trim().length === 0;
  check(
    'the turn ended with an answer rather than breaking down',
    !brokeDown,
    text.trim().length === 0
      ? 'the assistant said nothing at all'
      : text.slice(-200).replace(/\n+/g, ' '),
  );
  // The property that matters when a task is beyond what the tools can do: a
  // model that cannot do the thing must say so, not narrate a success it did
  // not have and not silently route around the tool surface.
  if (process.env.CU_EXPECT_REFUSAL === '1') {
    // Read the whole answer, not its last 260 characters.
    //
    // A good report of an impossible task says it cannot be done and then says
    // what would unblock it, so the closing words are the way forward rather
    // than the refusal. Measured: a save-pdf run that named the disabled menu
    // item, explained that it needs the app in front, and ended with "the one
    // thing that would unblock it is bringing 文本编辑 to the front yourself
    // — want to try that?" failed this check. It was the best answer in the
    // table. A tail-only test grades where a sentence sits, and rewards a
    // model that stops at the bad news.
    const said = /做不到|无法|不支持|没有.*(菜单|入口|办法)|cannot|unable|not supported/i.test(
      text,
    );
    // And it must not also be claiming the thing happened. The witness already
    // knows it did not; this is about what the model told the user.
    const claimed = /已(经)?(完成|导出|保存|生成)|successfully (exported|saved|created)/i.test(
      text,
    );
    check(
      'a task it cannot do is reported, not faked',
      said && !claimed,
      said
        ? `claimed success anyway: ${text.slice(-200).replace(/\n+/g, ' ')}`
        : text.slice(-260).replace(/\n+/g, ' '),
    );
  }

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
