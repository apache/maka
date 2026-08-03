#!/usr/bin/env node
// A matrix of real Computer Use work: the actual Maka app, a real model, and
// several real applications, one scenario after another in one launch.
//
// `cu-desktop-chain-real.mjs` proved the chain exists by asking for two steps
// against one app. This asks for the kind of thing a person would actually
// want — a sum computed by pressing keys, a sentence typed into a document, a
// search field filled and its results read, a list scrolled — across apps that
// differ in the ways that break automation: a grid of buttons with no titles,
// a text area that cannot be pressed, a search field that filters as it types,
// a scroll area taller than its window.
//
// Two rules the earlier harnesses learned the hard way:
//
//   1. Never read the result back through the thing being tested. Every check
//      here consults `cu-ax-oracle.swift`, a separate process walking the
//      system accessibility tree. When the model says it typed and the oracle
//      finds an empty document, the model is wrong — and a driver reporting
//      success on a control it never touched cannot hide behind its own
//      observation.
//   2. Judge the outcome, not the transcript. A turn that ends with "完成" and
//      changed nothing is the failure this is looking for.
//
// Only harmless targets: no documents are saved, no messages sent, nothing
// touched that the user would miss. TextEdit works in an unsaved scratch
// window; Calculator has no state; Font Book and Dictionary are read-only.
//
// Run: node scripts/cu-desktop-matrix-real.mjs [scenario-name ...]
import { _electron as electron } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'apps', 'desktop');
const ORACLE = join(ROOT, 'scripts', 'cu-ax-oracle.swift');
const OUT = process.env.CU_MATRIX_OUT ?? '/tmp/cu-desktop-matrix';
const TURN_TIMEOUT_MS = Number(process.env.CU_MATRIX_TURN_TIMEOUT ?? 300_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => console.log(line);

/**
 * The accessibility tree as a process that has never heard of maka-cu sees
 * it. Compiled fresh each call — `swift <file>` costs about a second, which is
 * nothing next to a model turn, and it keeps the oracle a script rather than a
 * build artifact that could drift from its source.
 */
async function oracle(bundleId, args = []) {
  try {
    const { stdout } = await exec('swift', [ORACLE, bundleId, ...args], {
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    return { error: 'oracle_failed', detail: String(error?.message ?? error).slice(0, 400) };
  }
}

/** Every element the oracle found, flattened to one searchable string. */
const oracleText = (tree) =>
  (tree.elements ?? [])
    .map((e) => [e.title, e.description, e.value].filter(Boolean).join(' '))
    .join('\n');

const displayValue = (tree, role) =>
  (tree.elements ?? []).filter((e) => e.role === role).map((e) => e.value ?? e.title ?? '');

/**
 * What is written in the app's own text and search fields.
 *
 * A search scenario used to be graded on whether the query appeared anywhere in
 * the tree, which a preinstalled font or a restored lookup satisfies without
 * anybody typing. The field is the one place the query can only have arrived by
 * being put there.
 */
const fieldValues = (tree) =>
  (tree.elements ?? [])
    .filter((e) => /AXTextField|AXComboBox|AXSearchField/.test(e.role ?? ''))
    .map((e) => String(e.value ?? ''));

async function quit(bundleId) {
  await exec('osascript', ['-e', `tell application id "${bundleId}" to quit saving no`]).catch(
    () => {},
  );
  await sleep(800);
}

/**
 * Start the app without letting it take the screen.
 *
 * `open -g` is the honest version of that, but some apps open no window at all
 * when launched that way — Font Book came up with zero windows and every
 * observation after it read `target_missing`, which looks exactly like a bug in
 * the thing being tested. So: try quietly, and if nothing opened, launch it
 * properly and put the front window back where it was.
 */
async function launchBackground(appName, bundleId) {
  await exec('open', ['-g', '-a', appName]).catch(() => {});
  await sleep(2000);
  if (!bundleId) return;
  const quiet = await oracle(bundleId);
  if ((quiet.window_count ?? 0) > 0) return;
  await exec('open', ['-a', appName]).catch(() => {});
  await sleep(2500);
  // Back to whoever was in front, so the turn still starts with the target
  // behind something — the case Computer Use exists for.
  await exec('osascript', [
    '-e',
    'tell application "System Events" to set frontmost of (first process whose name contains "Electron" or name contains "Maka") to true',
  ]).catch(() => {});
  await sleep(1200);
}

// ---------------------------------------------------------------------------
// The scenarios.
//
// `prompt` is what a person would type. `verify` gets the oracle's reading of
// the target app after the turn and returns the checks — each one a claim
// about the world, not about the conversation.
// ---------------------------------------------------------------------------
const SCENARIOS = [
  {
    name: 'calculator-arithmetic',
    app: 'Calculator',
    bundleId: 'com.apple.calculator',
    // Restart it so the display starts from a known place: a scenario that
    // passes because the previous run left the answer on screen is worthless.
    async setup() {
      await quit('com.apple.calculator');
      await launchBackground('Calculator', 'com.apple.calculator');
    },
    prompt:
      '用 computer use 操作计算器这个应用：先按 7，再按乘号，再按 8，最后按等号，' +
      '然后告诉我屏幕上显示的结果。计算器现在在后台，不要把它切到前台。',
    async verify(tree) {
      const shown = displayValue(tree, 'AXStaticText').join(' ');
      return [
        {
          label: 'the calculator display reads 56',
          pass: /\b56\b/.test(shown.replace(/[,\s]/g, ' ')),
          detail: `display: ${shown.trim() || '(empty)'}`,
        },
      ];
    },
  },
  {
    name: 'textedit-typing',
    app: 'TextEdit',
    bundleId: 'com.apple.TextEdit',
    // A scratch window with nothing in it, and nothing on disk to lose.
    async setup() {
      // Hiding the process was worse than useless: it left TextEdit with no
      // visible window, so a later scenario asking to observe it got
      // `target_missing` and the run blamed the tool.
      await quit('com.apple.TextEdit');
      await exec('osascript', [
        '-e',
        'tell application id "com.apple.TextEdit" to make new document',
      ]).catch(() => {});
      await sleep(2000);
      await exec('osascript', [
        '-e',
        'tell application "System Events" to set frontmost of (first process whose name contains "Electron" or name contains "Maka") to true',
      ]).catch(() => {});
      await sleep(1000);
    },
    prompt:
      '用 computer use 在文本编辑（TextEdit）的空白文稿里写入这一行文字：' +
      'the quick brown fox。写完确认一下文稿里确实有这行字。不要保存，也不要把它切到前台。',
    async verify(after, before) {
      const text = oracleText(after);
      // A document that already said it is not evidence that anything was
      // typed. One earlier run passed this on leftover text from a previous
      // session.
      const wasThereBefore = /the quick brown fox/i.test(oracleText(before));
      return [
        {
          label: 'the document did not already contain the sentence',
          pass: !wasThereBefore,
          detail: wasThereBefore ? 'left over from an earlier run' : 'started clean',
        },
        {
          label: 'the document contains the requested sentence',
          pass: /the quick brown fox/i.test(text) && !wasThereBefore,
          detail: text.replace(/\s+/g, ' ').slice(0, 200) || '(no text found)',
        },
      ];
    },
  },
  {
    name: 'fontbook-search',
    app: 'Font Book',
    bundleId: 'com.apple.FontBook',
    async setup() {
      await quit('com.apple.FontBook');
      await launchBackground('Font Book', 'com.apple.FontBook');
    },
    prompt:
      '用 computer use 在字体册（Font Book）的搜索框里搜索 Courier，' +
      '然后告诉我结果列表里出现了哪些字体。它在后台，不要切到前台。',
    async verify(after, before) {
      // Courier ships with macOS and the font list shows it without anybody
      // searching, so "the tree mentions Courier" is a check the model can pass
      // by doing nothing — the same failure `textedit-typing` already guards
      // against below. What only a search produces is the query sitting in the
      // search field, and a list that did not show Courier before and does now.
      const fieldsBefore = fieldValues(before).join(' | ');
      const fieldsAfter = fieldValues(after).join(' | ');
      const listedBefore = /courier/i.test(oracleText(before));
      const listedAfter = /courier/i.test(oracleText(after));
      const alreadyTyped = /courier/i.test(fieldsBefore);
      return [
        {
          label: 'nothing was already searching for Courier',
          pass: !alreadyTyped && !listedBefore,
          detail: alreadyTyped
            ? `the search field already read ${JSON.stringify(fieldsBefore)}`
            : listedBefore
              ? 'the font list was already showing Courier before the turn'
              : 'started clean',
        },
        {
          label: 'the search field holds the query',
          pass: !alreadyTyped && /courier/i.test(fieldsAfter),
          detail: `fields: ${fieldsAfter || '(all empty)'}`,
        },
        {
          label: 'the font list is showing Courier and was not before',
          pass: listedAfter && !listedBefore,
          detail: (oracleText(after).match(/.{0,40}[Cc]ourier.{0,40}/) ?? ['(not found)'])[0],
        },
      ];
    },
  },
  {
    name: 'dictionary-lookup',
    app: 'Dictionary',
    bundleId: 'com.apple.Dictionary',
    async setup() {
      await quit('com.apple.Dictionary');
      await launchBackground('Dictionary', 'com.apple.Dictionary');
    },
    prompt:
      '用 computer use 在词典（Dictionary）里查 serendipity 这个词，' +
      '然后把它的释义念给我听。它在后台，不要切到前台。',
    async verify(after, before) {
      // Dictionary restores its last lookup when it launches, so a rerun of
      // this scenario passed on the previous run's state. Quitting it first is
      // not enough — the restore happens on the next launch. The state has to
      // be shown not to have been there already.
      const shownBefore = /serendipity/i.test(oracleText(before));
      const shownAfter = /serendipity/i.test(oracleText(after));
      const fieldsAfter = fieldValues(after).join(' | ');
      return [
        {
          label: 'the word was not already looked up',
          pass: !shownBefore,
          detail: shownBefore ? 'restored from an earlier run' : 'started clean',
        },
        {
          label: 'the dictionary is showing the looked-up word',
          pass: shownAfter && !shownBefore,
          detail: (oracleText(after).match(/.{0,60}[Ss]erendipity.{0,60}/) ?? ['(not found)'])[0],
        },
        {
          label: 'the search field holds the word',
          pass: /serendipity/i.test(fieldsAfter),
          detail: `fields: ${fieldsAfter || '(all empty)'}`,
        },
      ];
    },
  },
  {
    name: 'dictionary-scroll',
    app: 'Dictionary',
    bundleId: 'com.apple.Dictionary',
    // Scrolling is the action that most needs the semantic path: the
    // coordinate `scroll` aims at a pixel and needs the window visible to
    // convert, which is exactly the case Computer Use exists for. The oracle
    // here is the scroll bar's own value — 0 at the top, 1 at the bottom — read
    // from the accessibility tree rather than from the driver's report.
    async setup() {
      await quit('com.apple.Dictionary');
      await launchBackground('Dictionary', 'com.apple.Dictionary');
      await sleep(1500);
    },
    prompt:
      '用 computer use 在词典（Dictionary）里查 computer 这个词，' +
      '然后把释义内容向下滚动两页，让我看到后面的内容。它在后台，不要切到前台。',
    async verify(after, before) {
      const scrollOf = (tree) =>
        (tree.elements ?? [])
          .filter((e) => e.role === 'AXScrollBar')
          .map((e) => Number(e.value))
          .filter((n) => Number.isFinite(n));
      const start = scrollOf(before);
      const end = scrollOf(after);
      // Against `start`, not against zero.
      //
      // `start` used to be computed and then used only in the detail string,
      // and the pass condition was `end.some(v => v > 0.001)`. A window that
      // restored already scrolled passed with no action at all, and a scroll
      // that went upwards passed too.
      const comparable = start.length > 0 && start.length === end.length;
      const advanced = comparable && end.some((v, index) => v > start[index] + 0.001);
      return [
        {
          label: 'the scroll position was readable before and after',
          pass: comparable,
          detail: `scroll bars before ${start.length}, after ${end.length}`,
        },
        {
          label: 'the content scrolled down from where it started',
          pass: advanced,
          detail: `scroll bar before [${start.join(', ')}] after [${end.join(', ')}]`,
        },
      ];
    },
  },
  {
    name: 'calculator-menu',
    app: 'Calculator',
    bundleId: 'com.apple.calculator',
    // The menu bar is the one part of an app that is not in any window, and
    // switching Calculator to its scientific layout is the cheapest reversible
    // proof that a menu item can be reached at all.
    async setup() {
      await quit('com.apple.calculator');
      await launchBackground('Calculator', 'com.apple.calculator');
    },
    prompt:
      '用 computer use 把计算器切换到「科学型」模式（在「显示」菜单里）。' +
      '切完之后观察一下，确认窗口里出现了科学计算的按钮。它在后台，不要切到前台。',
    async verify(after, before) {
      // Against `before`, because the teardown below is best-effort: it clicks
      // a menu item by index in a localised process name, and when that misses,
      // Calculator stays scientific and the next run of this scenario passed a
      // fixed threshold forever without the model touching anything.
      const buttonsBefore = displayValue(before, 'AXButton').length;
      const widthBefore = before.windows?.[0]?.frame?.w ?? 0;
      const buttonsAfter = displayValue(after, 'AXButton').length;
      const widthAfter = after.windows?.[0]?.frame?.w ?? 0;
      const startedBasic = buttonsBefore <= 25 && widthBefore <= 400;
      return [
        {
          label: 'the calculator started in the basic layout',
          pass: startedBasic,
          detail: `${buttonsBefore} buttons, window width ${widthBefore}`,
        },
        {
          label: 'the calculator switched to the scientific layout',
          pass: startedBasic && (buttonsAfter > buttonsBefore || widthAfter > widthBefore + 1),
          detail: `${buttonsBefore} → ${buttonsAfter} buttons, width ${widthBefore} → ${widthAfter}`,
        },
      ];
    },
    async teardown() {
      // Put it back the way it was found.
      await exec('osascript', [
        '-e',
        'tell application "System Events" to tell process "计算器" to click menu item 1 of menu 1 of menu bar item 4 of menu bar 1',
      ]).catch(() => {});
    },
  },
  {
    name: 'multi-app-survey',
    app: 'Calculator',
    bundleId: 'com.apple.calculator',
    async setup() {
      await launchBackground('Calculator', 'com.apple.calculator');
      await launchBackground('TextEdit', 'com.apple.TextEdit');
    },
    prompt:
      '用 computer use 看一下我现在开着哪些应用，然后分别观察计算器和文本编辑这两个应用的窗口，' +
      '告诉我它们各自的窗口标题和大概有多少个可交互的控件。都在后台，不要切换。',
    // Nothing in the world changes, so the checks live entirely in the ledger
    // (below): did it list apps, and did it observe two different ones.
    async verify() {
      return [];
    },
    ledgerChecks(calls) {
      const observed = new Set(
        calls
          .filter((c) => c.action === 'observe')
          .map((c) => String(c.args?.app ?? '').toLowerCase())
          .filter(Boolean),
      );
      return [
        {
          label: 'it enumerated the running apps instead of guessing',
          pass: calls.some((c) => c.action === 'list_apps'),
          detail: calls.map((c) => c.action).join(' → ') || '(no computer calls)',
        },
        {
          label: 'it observed two different applications',
          pass: observed.size >= 2,
          detail: [...observed].join(', ') || '(none)',
        },
      ];
    },
  },
];

const selected = process.argv.slice(2).length
  ? SCENARIOS.filter((s) => process.argv.slice(2).includes(s.name))
  : SCENARIOS;
if (selected.length === 0) {
  console.log(`no scenario matched. known: ${SCENARIOS.map((s) => s.name).join(', ')}`);
  process.exit(64);
}

await mkdir(OUT, { recursive: true });

// The lock check first, always: it is one syscall, and every tree on the
// machine is wrong while it is true.
{
  const probe = await oracle('com.apple.finder');
  if (probe.error === 'screen_locked') {
    console.log(
      'the screen is locked — every observation would return a menu-only tree. Unlock and re-run.',
    );
    process.exit(2);
  }
}

const app = await electron.launch({ args: ['.'], cwd: DESKTOP });
const mainLogs = [];
app.on('console', (m) => mainLogs.push(m.text()));
const report = [];

try {
  const page = await app.firstWindow();
  page.on('console', (m) => {
    if (m.type() === 'error') mainLogs.push(`[renderer] ${m.text()}`);
  });
  await page.waitForSelector('.maka-composer-textarea', { timeout: 60_000 });
  await sleep(1500);

  // Computer Use is off until a person turns it on, and the tools are withheld
  // from the model's surface while it is off — so a harness that does not turn
  // it on measures an empty tool list and blames the model.
  const enabled = await page.evaluate(async () => {
    await window.maka.settings.update({ computerUse: { enabled: true } });
    return (await window.maka.settings.get()).computerUse.enabled;
  });
  if (enabled !== true) {
    log('could not enable Computer Use; the model would see no tools. Stopping.');
    process.exit(2);
  }
  // The app restores whatever route it was last on, and a settings panel left
  // open intercepts every click in the chat — including the one that starts a
  // conversation. Dismiss it before driving anything.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (
      (await page
        .locator('.settingsModal')
        .count()
        .catch(() => 0)) === 0
    )
      break;
    await page.keyboard.press('Escape');
    await sleep(600);
  }
  if (
    (await page
      .locator('.settingsModal')
      .count()
      .catch(() => 0)) > 0
  ) {
    log('a settings panel is open and will not close; it intercepts the composer. Stopping.');
    process.exit(2);
  }
  log('app up, Computer Use enabled\n');

  for (const scenario of selected) {
    log(`\n${'='.repeat(70)}\n${scenario.name}  (${scenario.app})\n${'='.repeat(70)}`);
    await scenario.setup?.();

    const before = await oracle(scenario.bundleId);
    if (before.error) {
      // A skip is a failed run, not a quiet one. It is counted in the exit code
      // at the bottom of this file, because the state this used to produce —
      // every scenario skipped, "0/0 checks passed", exit 0 — is a harness
      // announcing success for having measured nothing.
      log(`  target unavailable: ${before.error} — skipping (this makes the run fail)`);
      if (before.detail) log(`    ${before.detail}`);
      report.push({ scenario: scenario.name, skipped: before.error, detail: before.detail });
      continue;
    }
    log(`  before: ${before.window_count} window(s), ${before.element_count} elements`);

    // A fresh conversation per scenario, created and addressed by id.
    //
    // This used to click 新任务 and type into the composer, for realism. The
    // realism was not free: which session the composer was pointed at could not
    // be established from outside, and a run spent two scenarios reporting
    // "the model chose not to use Computer Use" when the turns were failing in
    // a different conversation, on a connection whose endpoint was down. Same
    // channel the composer uses, same runtime, same tools — just addressed.

    // Pin the conversation to a connection that answers.
    //
    // A session carries its own connection and model, and changing the default
    // only reaches sessions created afterwards — so a run can inherit an
    // endpoint that is no longer up and every turn fails with `errorClass:
    // unknown` before a single tool is called. That is indistinguishable, in
    // the report, from a model that chose not to use Computer Use.
    const started = await page.evaluate(async (prompt) => {
      const connections = await window.maka.connections.list();
      const wanted = await window.maka.connections.getDefault?.();
      const connection =
        connections.find((c) => c.slug === wanted && c.enabled !== false) ??
        connections.find((c) => c.enabled !== false);
      if (!connection) return { ok: false, why: 'no usable connection' };
      const model = connection.defaultModel ?? connection.enabledModelIds?.[0];
      if (!model) return { ok: false, why: `connection ${connection.slug} names no model` };
      const session = await window.maka.sessions.create({});
      // A session carries its own connection and model, and changing the
      // default only reaches sessions created afterwards — so a run can inherit
      // an endpoint that is no longer up and every turn fails before a single
      // tool is called, which reads in the report as a model that chose not to
      // use Computer Use.
      await window.maka.sessions.setModel(session.id, {
        llmConnectionSlug: connection.slug,
        model,
      });
      const turnId = crypto.randomUUID();
      await window.maka.sessions.send(session.id, { type: 'send', turnId, text: prompt });
      return { ok: true, sessionId: session.id, slug: connection.slug, model };
    }, scenario.prompt);
    if (!started.ok) {
      log(`  ${started.why} — every turn would fail before Computer Use ran. Stopping.`);
      process.exit(2);
    }
    const sessionId = started.sessionId;
    log(`  driving ${sessionId.slice(0, 8)} with ${started.slug} / ${started.model}`);
    const startedAt = Date.now();

    // Done when the session's own turn record says so, rather than when a
    // button disappears.
    const settled = async () => {
      const state = await page
        .evaluate(async (id) => {
          const messages = await window.maka.sessions.readMessages(id);
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i].type === 'turn_state') return messages[i].status;
          }
          return undefined;
        }, sessionId)
        .catch(() => undefined);
      return state === 'completed' || state === 'failed' || state === 'aborted';
    };
    const endBy = Date.now() + TURN_TIMEOUT_MS;
    let timedOut = false;
    while (!(await settled())) {
      if (Date.now() > endBy) {
        timedOut = true;
        await page.evaluate((id) => window.maka.sessions.stop(id), sessionId).catch(() => {});
        break;
      }
      await sleep(1000);
    }
    const elapsedMs = Date.now() - startedAt;
    await sleep(2500); // let the last action's effect land in the target app

    const messages = sessionId
      ? await page.evaluate((id) => window.maka.sessions.readMessages(id), sessionId)
      : [];
    const results = new Map(
      messages.filter((m) => m.type === 'tool_result').map((m) => [m.toolUseId, m]),
    );
    // Every tool, not only Computer Use. A scenario the model completed by
    // shelling out to osascript changes the world exactly the way the oracle
    // wants, and would otherwise be scored a pass for a chain that was never
    // exercised.
    // The bypass pattern, applied to the whole argument object.
    //
    // This used to be matched against `argsHead`, which is the first 200
    // characters. A shell command with a preamble, a `cd`, or a heredoc pushes
    // the `osascript` past 200 and the search saw nothing — on a check that
    // exists because a model was once caught driving the app around Computer
    // Use, with the oracle reporting a clean green for a chain that was never
    // exercised. Truncating the haystack of an anti-bypass search defeats it by
    // exactly the amount a bypass would need.
    const BYPASS = /osascript|System Events|applescript|\bopen -|cliclick|screencapture/i;
    const allCalls = messages
      .filter((m) => m.type === 'tool_call')
      .map((m) => {
        const result = results.get(m.id);
        const text =
          typeof result?.content === 'string'
            ? result.content
            : JSON.stringify(result?.content ?? '');
        const args = JSON.stringify(m.args ?? null).replace(/\s+/g, ' ');
        // Matched here, over the whole string, and only the excerpt is kept —
        // so the report stays readable without the check reading less than the
        // model wrote.
        const bypass = m.toolName === 'maka_computer' ? null : BYPASS.exec(args);
        return {
          tool: m.toolName,
          argsHead: args.slice(0, 200),
          argsLength: args.length,
          bypassAt: bypass
            ? {
                index: bypass.index,
                excerpt: args.slice(Math.max(0, bypass.index - 60), bypass.index + 120),
              }
            : null,
          // What the other tools answered, too. A scenario can turn on what
          // `load_tools` said back, and recording only the request left that
          // invisible.
          resultHead: text.replace(/\s+/g, ' ').slice(0, 300),
          isError: result?.isError === true,
        };
      });
    const calls = messages
      .filter((m) => m.type === 'tool_call' && m.toolName === 'maka_computer')
      .map((m) => {
        const result = results.get(m.id);
        const text =
          typeof result?.content === 'string'
            ? result.content
            : JSON.stringify(result?.content ?? '');
        return {
          action: m.args?.action ?? '?',
          args: m.args,
          isError: result?.isError ?? false,
          durationMs: result?.durationMs,
          // Failures are reported inside the text, not only by isError.
          failed: result?.isError === true || /\bfailed:|unsupported_action|blocked/.test(text),
          resultHead: text.replace(/\s+/g, ' ').slice(0, 220),
        };
      });
    const assistantText = messages
      .filter((m) => m.type === 'assistant')
      .map((m) => m.text ?? '')
      .join('\n');

    const after = await oracle(scenario.bundleId);
    const checks = [
      {
        label: 'the turn finished on its own',
        pass: !timedOut,
        detail: `${Math.round(elapsedMs / 1000)}s${timedOut ? ' — timed out and was stopped' : ''}`,
      },
      {
        label: 'it used Computer Use at all',
        pass: calls.length > 0,
        detail: `${calls.length} calls`,
      },
      {
        // Anything that can run a command can drive an app without Computer
        // Use — `osascript`, `open`, a script file. When that happens the world
        // changes, the oracle is satisfied, and nothing about the chain under
        // test was proven.
        label: 'it did not reach the app by some other route',
        pass: !allCalls.some(
          (c) => c.tool !== 'maka_computer' && (c.bypassAt !== null || BYPASS.test(c.tool)),
        ),
        detail:
          allCalls
            .filter((c) => c.tool !== 'maka_computer' && c.bypassAt)
            .map((c) => `${c.tool} @${c.bypassAt.index}: ${c.bypassAt.excerpt}`)
            .join(' | ') ||
          allCalls
            .filter((c) => c.tool !== 'maka_computer')
            .map((c) => `${c.tool} (${c.argsLength} chars searched)`)
            .join(', ') ||
          'no other tools',
      },
      {
        // Every pre-check below is a negative assertion about `before` — the
        // sentence was not there, the word was not looked up, the layout was
        // basic. A tree the oracle cut short reads as absence, so a truncated
        // witness would hand all of them a free pass.
        label: 'the witness read both trees whole',
        pass: before.truncated !== true && after.truncated !== true,
        detail: `before ${before.truncated ? 'cut' : 'whole'}, after ${after.truncated ? 'cut' : 'whole'}`,
      },
      ...(after.error
        ? [{ label: 'the target app survived the turn', pass: false, detail: after.error }]
        : await scenario.verify(after, before)),
      ...(scenario.ledgerChecks?.(calls) ?? []),
    ];

    for (const c of checks)
      log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
    const failedCalls = calls.filter((c) => c.failed);
    log(`  calls: ${calls.map((c) => c.action).join(' → ') || '(none)'}`);
    if (failedCalls.length) {
      log(`  ${failedCalls.length} call(s) came back a failure:`);
      for (const c of failedCalls.slice(0, 6)) log(`      ${c.action}: ${c.resultHead}`);
    }

    report.push({
      scenario: scenario.name,
      app: scenario.app,
      elapsedMs,
      timedOut,
      checks,
      calls,
      otherCalls: allCalls.filter((c) => c.tool !== 'maka_computer'),
      assistantTail: assistantText.slice(-1200),
      before: { windows: before.window_count, elements: before.element_count },
      after: after.error
        ? { error: after.error }
        : { windows: after.window_count, elements: after.element_count },
    });

    // Written after every scenario, not once at the end: a run this long is
    // read while it is still going, and a crash in scenario six must not take
    // the evidence from the first five with it.
    await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    await scenario.teardown?.();
  }
} catch (error) {
  log(`\n[ERROR] ${error?.stack ?? error?.message ?? error}`);
  report.push({ harnessError: String(error?.message ?? error) });
} finally {
  await app.close().catch(() => {});
}

await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
await writeFile(join(OUT, 'main-logs.txt'), mainLogs.join('\n'), 'utf8');

// What the run is allowed to call success.
//
// This used to be `report.flatMap(r => r.checks ?? [])`, which erases both the
// skip path and the harness-crash catch — a scenario that skipped contributes
// no checks, a crash contributes no checks, and `failed.length === 0` over an
// empty array is zero. A run in which every scenario skipped printed
// "0/0 checks passed" and exited 0, so the harness reported success having
// proven nothing at all. Which is the one outcome a harness must never produce.
const all = report.flatMap((r) => r.checks ?? []);
const failed = all.filter((c) => !c.pass);
const skipped = report.filter((r) => r.skipped);
const crashed = report.filter((r) => r.harnessError);
const ran = report.filter((r) => r.checks);
log(`\n${'='.repeat(70)}`);
for (const r of report) {
  if (!r.checks) continue;
  const bad = r.checks.filter((c) => !c.pass).length;
  log(
    `  ${bad === 0 ? 'OK  ' : 'FAIL'} ${r.scenario}  ${r.checks.length - bad}/${r.checks.length}`,
  );
}
for (const r of skipped) log(`  SKIP ${r.scenario} — the witness said ${r.skipped}`);
for (const r of crashed) log(`  CRASH the harness stopped: ${r.harnessError}`);
log(`${all.length - failed.length}/${all.length} checks passed — evidence in ${OUT}`);
if (ran.length < selected.length) {
  log(
    `${selected.length - ran.length} of ${selected.length} scenario(s) never produced a check.` +
      ' That is a failed run, not a clean one.',
  );
}
if (all.length === 0) {
  log('no check ran at all. There is no evidence here either way.');
}
process.exit(
  failed.length === 0 && skipped.length === 0 && crashed.length === 0 && all.length > 0 ? 0 : 1,
);
