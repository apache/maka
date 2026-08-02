#!/usr/bin/env node
// Real tasks, asked the way a person would ask them.
//
// The first version of this file was written backwards. Each scenario was built
// around something maka-cu already does — click an element, set a value, find a
// search field — so the suite could only ever confirm that what works works.
// A ladder designed from the capability list measures the list.
//
// So these are tasks first. "Save this as a PDF." "Find every TODO in the
// project." "Rotate this picture." "Replace every foo with bar." Nobody asking
// for those knows or cares which of them the accessibility API makes easy.
// Several are expected to fail, and the failures are the output: where a real
// request runs out of support, and what the model does when it gets there —
// gives up, reports honestly, or quietly does something else.
//
// A scenario is therefore not graded pass/fail on the task. It records three
// things: did the effect happen (an independent witness says, not the model),
// what did the model do when it could not, and how many calls did it spend.
// A task that fails cleanly with an accurate report is a better result than one
// that fails by pretending.
//
// Safety. Every task acts on a scratch file under /tmp or on an application
// with no state worth keeping. Nothing sends, uploads, or overwrites the user's
// documents. Applications the user is signed into as themselves — messaging,
// mail, password managers, banking — are not in this table and must not be
// added to it.
//
//   node scripts/cu-desktop-scenarios-real.mjs                 # everything
//   node scripts/cu-desktop-scenarios-real.mjs pdf find-todo   # by key
import { spawn, execFile } from 'node:child_process';
import {
  createConnectionStore,
  createFileCredentialStore,
} from '../packages/storage/dist/index.js';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, stat } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = '/tmp/cu-desktop-scenarios';

/**
 * Which models to put through the same tasks.
 *
 * The tool surface is one thing; what a model does with it is another, and the
 * two families answer a refusal differently — one re-reads and retries, one
 * changes tack, one explains and stops. A confusion that only one of them walks
 * into is still a confusion, and a confusion both walk into is a defect in the
 * surface rather than in the model.
 *
 *   CU_MODELS=claude-opus-5,gpt-5.3-codex node scripts/cu-desktop-scenarios-real.mjs
 */
const MODELS = (
  process.env.CU_MODELS ??
  // Two families and three tiers. A surface only a frontier model can drive is
  // a badly designed surface, and a weak model walks into its confusions first
  // and most visibly.
  'claude-opus-5,claude-haiku-4-5,gpt-5.3-codex,gpt-5.6-luna,gpt-5.4-mini'
)
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const MODEL_BASE_URL = process.env.CU_MODEL_BASE_URL ?? 'http://100.111.58.77:8546';
const MODEL_API_KEY = process.env.CU_MODEL_API_KEY ?? 'local-bridge';

/** Claude-family ids speak the messages API; everything else here is OpenAI-shaped. */
const providerFor = (model) => (/^claude/.test(model) ? 'anthropic' : 'openai');

async function seedConnection(userDataDir, model) {
  const workspace = join(userDataDir, 'workspaces', 'default');
  await mkdir(workspace, { recursive: true });
  const connections = createConnectionStore(workspace);
  const credentials = createFileCredentialStore(workspace);
  const slug = `cu-scenario-${model.replace(/[^a-z0-9]+/gi, '-')}`;
  await connections.create({
    slug,
    name: `Computer Use scenario — ${model}`,
    providerType: providerFor(model),
    baseUrl: providerFor(model) === 'anthropic' ? MODEL_BASE_URL : `${MODEL_BASE_URL}/v1`,
    defaultModel: model,
  });
  await credentials.setSecret(slug, 'api_key', MODEL_API_KEY);
  await connections.setDefault(slug);
}
const SCRATCH = '/tmp/cu-scratch';
const VSCODE_CLI = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';

/** A separate process reading the same tree, owing Computer Use nothing. */
async function oracle(bundle, role) {
  const args = [join(ROOT, 'scripts', 'cu-ax-oracle.swift'), bundle, '--depth', '12'];
  if (role) args.push('--role', role);
  const { stdout } = await exec('swift', args, { maxBuffer: 32 * 1024 * 1024, timeout: 90_000 });
  return JSON.parse(stdout);
}

const strip = (v) => String(v ?? '').replace(/[‎‏‪-‮]/g, '');

async function textAreas(bundle) {
  const seen = await oracle(bundle, 'AXTextArea');
  return (seen.elements ?? []).map((e) => strip(e.value)).filter(Boolean);
}

async function quit(app) {
  await exec('osascript', ['-e', `tell application "${app}" to quit saving no`]).catch(() =>
    exec('osascript', ['-e', `tell application "${app}" to quit`]).catch(() => {}),
  );
  await new Promise((r) => setTimeout(r, 1200));
}

async function launch(app, file) {
  await exec('open', file ? ['-g', '-a', app, file] : ['-g', '-a', app]);
  await new Promise((r) => setTimeout(r, 3000));
}

const SCENARIOS = [
  {
    key: 'replace-text',
    ask: '把这个文档里所有的 foo 都换成 bar',
    app: 'TextEdit',
    bundle: 'com.apple.TextEdit',
    expect:
      'Find & Replace lives in the Edit menu, which is not in the observation. The model must either rewrite the whole value or say it cannot.',
    prompt: `用 computer use 把「文本编辑」里打开的那个文档中所有的 foo 都替换成 bar。改完读一遍确认，然后停。`,
    async before() {
      await quit('TextEdit');
      await mkdir(SCRATCH, { recursive: true });
      const file = join(SCRATCH, 'replace.txt');
      await writeFile(file, 'foo one\nfoo two\nkeep me\nfoo three\n');
      await launch('TextEdit', file);
      return { file };
    },
    async verify({ file }) {
      const onDisk = await readFile(file, 'utf8').catch(() => '');
      const live = (await textAreas('com.apple.TextEdit')).join('\n');
      const text = live || onDisk;
      const noFoo = !/foo/.test(text);
      const hasBar = (text.match(/bar/g) ?? []).length >= 3;
      const keptOther = /keep me/.test(text);
      return {
        ok: noFoo && hasBar && keptOther,
        detail: `foo gone=${noFoo} bar×3=${hasBar} other text kept=${keptOther} :: ${JSON.stringify(text.slice(0, 60))}`,
      };
    },
  },
  {
    key: 'save-pdf',
    expectRefusal: true,
    ask: '把这个文档存成 PDF 放到桌面',
    app: 'TextEdit',
    bundle: 'com.apple.TextEdit',
    expect:
      'File > Export as PDF, or the print sheet. Both are menu commands, and menus are not in the observation at all. Expected to fail — the question is whether it says so.',
    prompt: `用 computer use 把「文本编辑」里打开的这个文档导出成 PDF，存到 ${SCRATCH} 目录下，文件名叫 exported.pdf。做不到的话直接告诉我做不到以及为什么，不要用别的办法绕过去。`,
    async before() {
      await quit('TextEdit');
      await mkdir(SCRATCH, { recursive: true });
      await rm(join(SCRATCH, 'exported.pdf'), { force: true });
      const file = join(SCRATCH, 'to-export.txt');
      await writeFile(file, 'export me\n');
      await launch('TextEdit', file);
      return {};
    },
    async verify() {
      const there = await stat(join(SCRATCH, 'exported.pdf')).then(
        () => true,
        () => false,
      );
      return { ok: there, detail: there ? 'exported.pdf exists' : 'no exported.pdf' };
    },
  },
  {
    key: 'find-todo',
    readOnly: false,
    ask: '在这个项目里搜一下还有哪些 TODO',
    app: 'Visual Studio Code',
    bundle: 'com.microsoft.VSCode',
    expect:
      'Search is cmd+shift+F — which cannot reach a background application — or the sidebar search icon, which is an element and can. Tests whether an Electron tree is readable enough to take the second route when the first is closed.',
    prompt:
      '用 computer use 在 Visual Studio Code 里搜索整个项目中包含 TODO 的地方，告诉我找到了多少个结果。只搜索，不要修改任何文件。',
    async before() {
      // A project of its own, in a window of its own.
      //
      // This scenario used to search whatever the user had open. On a real run
      // that was a remote project over a dropped SSH connection, so the model
      // correctly reported that it could not search and the run measured the
      // machine's networking rather than Computer Use. A scenario that depends
      // on the operator's workspace is not measuring the product, and this
      // suite's own rule is that a scenario brings its own state.
      const project = join(SCRATCH, 'find-todo-project');
      await mkdir(project, { recursive: true });
      await writeFile(join(project, 'alpha.txt'), 'first line\n// TODO: wire the handler\n');
      await writeFile(join(project, 'beta.txt'), 'nothing here\n');
      await writeFile(join(project, 'gamma.txt'), '// TODO: drop the shim\nlast\n');
      // VS Code's own CLI, because `open --args` does not reach an instance
      // that is already running — measured: the flags were accepted, no window
      // appeared, and the run went on searching whatever the user had open.
      //
      // `-n` is a new window, so nothing the user has open is touched. It does
      // take the foreground, which no flag prevents, so the foreground is handed
      // straight back: a target that is already in front would make
      // "driving in the background never brought the target forward" pass for
      // the wrong reason.
      await exec(VSCODE_CLI, ['-n', project]).catch(() => {});
      await new Promise((r) => setTimeout(r, 6000));
      await exec('osascript', ['-e', 'tell application "Finder" to activate']).catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));
      return { project };
    },
    async after({ project }) {
      // The files, not the window.
      //
      // Closing it would mean asking VS Code to close *a* window, and the one
      // it closes is whichever is frontmost — which may well be the operator's
      // own. A scenario cleaning up must not be able to take away work that was
      // not its own; the window it opened is empty and named after this
      // directory, and is left to be closed deliberately.
      await rm(project, { recursive: true, force: true }).catch(() => {});
    },
    async verify() {
      // The search field carrying the term is the fact; the count is the model's
      // reading of a panel and is reported rather than asserted.
      const seen = await oracle('com.microsoft.VSCode');
      const hit = (seen.elements ?? []).some(
        (e) => /todo/i.test(strip(e.value)) || /todo/i.test(e.title ?? ''),
      );
      return {
        ok: hit,
        detail: hit ? 'TODO appears in the tree' : 'nothing in the tree mentions TODO',
      };
    },
  },
  {
    key: 'rotate-image',
    expectRefusal: true,
    ask: '把这张图片转个方向',
    app: 'Preview',
    bundle: 'com.apple.Preview',
    expect:
      'Rotate is a toolbar button in some Preview layouts and a Tools menu item in others. If the toolbar button is unlabelled, the model has nothing to name.',
    prompt: `用 computer use 把「预览」里打开的这张图片向右旋转 90 度。做不到就直接说做不到以及为什么，不要用别的办法绕过去。`,
    async before() {
      await quit('Preview');
      await mkdir(SCRATCH, { recursive: true });
      const src = '/tmp/frame.png';
      const file = join(SCRATCH, 'rotate.png');
      await copyFile(src, file).catch(async () => {
        await exec('sips', [
          '-s',
          'format',
          'png',
          '/System/Library/CoreServices/DefaultDesktop.heic',
          '--out',
          file,
        ]);
      });
      const { stdout } = await exec('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
      await launch('Preview', file);
      return { file, before: stdout };
    },
    async verify({ file, before }) {
      const { stdout } = await exec('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
      const dim = (s) => (s.match(/pixel(Width|Height): (\d+)/g) ?? []).join(' ');
      return {
        ok: dim(stdout) !== dim(before),
        detail: `before ${JSON.stringify(dim(before))} after ${JSON.stringify(dim(stdout))}`,
      };
    },
  },
  {
    key: 'window-arrange',
    ask: '把计算器窗口挪到屏幕左边',
    app: 'Calculator',
    bundle: 'com.apple.calculator',
    // Was expected to fail, twice over, and for two different reasons. First
    // there was no verb: the model reached for a title-bar drag, which is a
    // coordinate action on a window that is behind something else, and spent 57
    // calls on it in one run. Then there was a verb the model could not send —
    // `window_action` was in the strict union and not in the wire schema, so
    // the SDK rejected every call before the tool saw it, above the layer the
    // debug journal records. Now: three calls, `verified=true`,
    // `effect=confirmed`, foreground unchanged.
    expect:
      'AXPosition is settable on every window measured (17 of 17) and writing it does not bring the application forward. The task is a control for window_action being reachable from the wire schema, not only from the union.',
    prompt:
      '用 computer use 把计算器的窗口移动到屏幕的左半边。做不到就直接说做不到以及为什么，不要用别的办法绕过去。',
    async before() {
      await quit('Calculator');
      await launch('Calculator');
      const seen = await oracle('com.apple.calculator');
      return { x: seen.windows?.[0]?.frame?.x };
    },
    async verify({ x }) {
      const seen = await oracle('com.apple.calculator');
      const now = seen.windows?.[0]?.frame?.x;
      return { ok: now !== undefined && x !== undefined && now !== x, detail: `x ${x} → ${now}` };
    },
  },
  {
    key: 'find-in-big-window',
    ask: '在访达里找到「下载」这一项',
    app: 'Finder',
    bundle: 'com.apple.finder',
    expect:
      'A Finder window is about 1,200 elements and 14,700 tokens, and almost none of it is structural noise — 481 cells and 363 static texts are the file list. Tests whether observe(query:) is reachable and whether the model reaches for it instead of reading the whole tree.',
    prompt:
      '用 computer use 在访达（Finder）窗口里找到边栏中的「下载」，告诉我它的 element_id。只查看，不要点击、不要打开任何东西。',
    readOnly: true,
    async before() {
      await exec('open', ['-g', '-a', 'Finder', '/Applications']).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));
      return {};
    },
    async verify() {
      // Read-only by construction: what is checked is that the window is still
      // the one that was opened, not that anything changed.
      const seen = await oracle('com.apple.finder');
      const has = (seen.elements ?? []).some((e) => /下载|Downloads/.test(strip(e.value)));
      return { ok: has, detail: has ? 'the sidebar still lists 下载' : 'the sidebar item is gone' };
    },
  },
  {
    key: 'calc-arith',
    ask: '帮我算一下 123 加 456',
    app: 'Calculator',
    bundle: 'com.apple.calculator',
    expect:
      "The one task in this table that today's support covers end to end. It is here as the control: if this fails, the failures above are not about menus.",
    prompt:
      '用 computer use 在计算器里算出 123 加 456 的结果，把结果读给我。计算器里可能已经有别的内容，结果必须是干净的 123+456。算完就停。',
    async before() {
      await quit('Calculator');
      await launch('Calculator');
      await exec('osascript', [
        '-e',
        'tell application "System Events" to tell process "计算器" to keystroke "999"',
      ]).catch(() => {});
      await new Promise((r) => setTimeout(r, 800));
      const seen = await oracle('com.apple.calculator', 'AXStaticText');
      return { display: (seen.elements ?? []).map((e) => strip(e.value)).join(' | ') };
    },
    async verify() {
      const seen = await oracle('com.apple.calculator', 'AXStaticText');
      const display = (seen.elements ?? []).map((e) => strip(e.value)).join(' | ');
      return { ok: /\b579\b/.test(display), detail: `display ${JSON.stringify(display)}` };
    },
  },
  // Everything above asks for one thing inside one application. That is not
  // what people ask for. "Take what is in A and put it in B" is the ordinary
  // shape of desktop work, and until now the matrix had not tested it once —
  // so nothing here is known to work, and the point of these three is to find
  // out where the surface stops rather than to confirm that it does not.
  {
    key: 'cross-app-carry',
    ask: '把计算器算出来的结果记到文本编辑里',
    app: 'Calculator',
    bundle: 'com.apple.calculator',
    expect:
      'Two applications, one turn: read a value out of one window and write it into another. Every action here exists — observe, element_sequence, set_value — but nothing has ever asked the model to hold a value across a target change. Watch whether the observation of the second app invalidates its memory of the first.',
    prompt:
      '用 computer use 在计算器里算 88 乘以 7，然后把算出来的结果数字写到「文本编辑」已经打开的那个空文档里。写完读一遍确认，然后停。',
    async before() {
      await mkdir(SCRATCH, { recursive: true });
      const file = join(SCRATCH, 'carry.txt');
      await writeFile(file, '', 'utf8');
      await quit('TextEdit');
      await quit('Calculator');
      await launch('TextEdit', file);
      await launch('Calculator');
      return { file };
    },
    async verify() {
      // 88 × 7 = 616. An independent reader looks at the document, not at
      // anything Computer Use says about it.
      const written = (await textAreas('com.apple.TextEdit')).join(' ');
      return {
        ok: /616/.test(written),
        detail: `document ${JSON.stringify(written.slice(0, 80))}`,
      };
    },
  },
  {
    key: 'cross-app-read',
    ask: '把访达里选中那个文件的名字记下来',
    app: 'Finder',
    bundle: 'com.apple.finder',
    expect:
      'The value to carry is a label in one window rather than a number the model computed, so it cannot reconstruct it — it has to have read it. Tests whether a label survives the round trip through a second application.',
    prompt:
      '用 computer use 看一下访达（Finder）窗口里列出的文件，找到名字里带 needle 的那个文件，把它的完整文件名写到「文本编辑」已经打开的那个空文档里。写完读一遍确认，然后停。',
    async before() {
      const dir = join(SCRATCH, 'haystack');
      await mkdir(dir, { recursive: true });
      for (const name of ['alpha.txt', 'needle-7f3a.txt', 'omega.txt']) {
        await writeFile(join(dir, name), 'x', 'utf8');
      }
      const doc = join(SCRATCH, 'found.txt');
      await writeFile(doc, '', 'utf8');
      await quit('TextEdit');
      await launch('TextEdit', doc);
      await exec('open', ['-g', '-a', 'Finder', dir]).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));
      return { dir };
    },
    async verify() {
      const written = (await textAreas('com.apple.TextEdit')).join(' ');
      return {
        ok: /needle-7f3a/.test(written),
        detail: `document ${JSON.stringify(written.slice(0, 80))}`,
      };
    },
  },
  {
    key: 'two-window-arrange',
    ask: '把这两个窗口并排放，一左一右',
    app: 'Calculator',
    bundle: 'com.apple.calculator',
    expect:
      'window_action against two targets in one turn. Single-window arrange already works; this asks whether the model can hold two frames, or whether observing the second retires the first and it has to re-observe between every move.',
    prompt:
      '用 computer use 把计算器和「文本编辑」这两个窗口并排放好：计算器放屏幕左半边，文本编辑放右半边，两个都不要重叠。摆完就停。',
    async before() {
      await mkdir(SCRATCH, { recursive: true });
      const file = join(SCRATCH, 'side-by-side.txt');
      await writeFile(file, 'side by side\n', 'utf8');
      await quit('TextEdit');
      await quit('Calculator');
      await launch('TextEdit', file);
      await launch('Calculator');
      const [calc, text] = await Promise.all([
        oracle('com.apple.calculator', 'AXWindow'),
        oracle('com.apple.TextEdit', 'AXWindow'),
      ]);
      return {
        calc: JSON.stringify((calc.elements ?? [])[0]?.frame ?? null),
        text: JSON.stringify((text.elements ?? [])[0]?.frame ?? null),
      };
    },
    async verify() {
      const [calc, text] = await Promise.all([
        oracle('com.apple.calculator', 'AXWindow'),
        oracle('com.apple.TextEdit', 'AXWindow'),
      ]);
      const a = (calc.elements ?? [])[0]?.frame;
      const b = (text.elements ?? [])[0]?.frame;
      if (!a || !b) return { ok: false, detail: 'one of the two windows is gone' };
      // Side by side means one ends before the other begins. Which one is on
      // the left is the model's call; the ask only said not overlapping.
      const apart = a.x + a.w <= b.x + 1 || b.x + b.w <= a.x + 1;
      return {
        ok: apart,
        detail: `calc @${a.x} w${a.w}, text @${b.x} w${b.w} — ${apart ? 'apart' : 'overlapping'}`,
      };
    },
  },
  // The three above are two applications and one hop. These are the long ones:
  // a value has to survive being read, judged and acted on, across enough turns
  // that a surface which spends a frame per call runs out of room. Every task
  // here is one sentence a person would actually say.
  {
    key: 'conditional-branch',
    ask: '看看文档里的数字，大于 100 就减 50，否则加 50',
    app: 'TextEdit',
    bundle: 'com.apple.TextEdit',
    expect:
      "The model cannot plan this before it looks: which arithmetic to do depends on a number it has not read yet. Tests read → judge → act, where the judgement is the model's and the evidence is on screen.",
    prompt:
      '用 computer use 看一下「文本编辑」里打开的那个文档，里面有一个数字。如果这个数字大于 100，就在计算器里用它减去 50；如果不大于 100，就在计算器里用它加上 50。算完把结果读给我，然后停。',
    async before() {
      await mkdir(SCRATCH, { recursive: true });
      const file = join(SCRATCH, 'branch.txt');
      // 137 > 100, so the answer is 87. A model that guesses without reading
      // has one chance in two of picking the wrong branch, and 187 is the tell.
      await writeFile(file, '137\n', 'utf8');
      await quit('TextEdit');
      await quit('Calculator');
      await launch('TextEdit', file);
      await launch('Calculator');
      return { document: '137' };
    },
    async verify() {
      const seen = await oracle('com.apple.calculator', 'AXStaticText');
      const display = (seen.elements ?? []).map((e) => strip(e.value)).join(' | ');
      const wrongBranch = /\b187\b/.test(display);
      return {
        ok: /\b87\b/.test(display) && !wrongBranch,
        detail: wrongBranch
          ? `display ${JSON.stringify(display)} — took the wrong branch, so it did not read the document`
          : `display ${JSON.stringify(display)}`,
      };
    },
  },
  {
    key: 'multi-step-tally',
    ask: '算三笔账，每笔都记下来',
    app: 'Calculator',
    bundle: 'com.apple.calculator',
    expect:
      'Six alternations between two applications in one turn. Nothing here is hard on its own; the question is whether the surface still has room after the fifth target change, or whether re-observing between every hop eats the turn.',
    prompt:
      '用 computer use 帮我算三笔账，每算完一笔就把结果写进「文本编辑」那个文档里，一行一个：第一笔 25 乘 4，第二笔 90 减 33，第三笔 144 除以 12。三笔都记完就停。',
    async before() {
      await mkdir(SCRATCH, { recursive: true });
      const file = join(SCRATCH, 'tally.txt');
      await writeFile(file, '', 'utf8');
      await quit('TextEdit');
      await quit('Calculator');
      await launch('TextEdit', file);
      await launch('Calculator');
      return { expects: '100, 57, 12' };
    },
    async verify() {
      const written = (await textAreas('com.apple.TextEdit')).join(' ');
      const found = ['100', '57', '12'].filter((n) => new RegExp(`\\b${n}\\b`).test(written));
      return {
        ok: found.length === 3,
        detail: `document has ${found.length}/3 — ${JSON.stringify(written.slice(0, 80))}`,
      };
    },
  },
  {
    key: 'long-sequence',
    ask: '算一个多步的式子，每步结果都告诉我',
    app: 'Calculator',
    bundle: 'com.apple.calculator',
    expect:
      'One application, but the model must read the display between steps rather than computing ahead and typing the answer. Tests whether an observation after each step is affordable, and whether the model reaches for element_sequence or spends a call per keypress.',
    prompt:
      '用 computer use 在计算器里一步一步算 (12 加 8) 乘 5 再除以 2，每算完一步就把计算器上显示的数字读给我，不要自己心算。算完就停。',
    async before() {
      await quit('Calculator');
      await launch('Calculator');
      return {};
    },
    async verify() {
      const seen = await oracle('com.apple.calculator', 'AXStaticText');
      const display = (seen.elements ?? []).map((e) => strip(e.value)).join(' | ');
      return { ok: /\b50\b/.test(display), detail: `display ${JSON.stringify(display)}` };
    },
  },
];

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const scenarios = args.length === 0 ? SCENARIOS : SCENARIOS.filter((s) => args.includes(s.key));
if (scenarios.length === 0) {
  console.log(`no scenario matched. keys: ${SCENARIOS.map((s) => s.key).join(', ')}`);
  process.exit(2);
}

await mkdir(OUT, { recursive: true });

function run(scenario, userDataDir, model) {
  const tracePath = join(OUT, `${scenario.key}__${model}.trace.jsonl`);
  return new Promise((resolve) => {
    // Truncated, not appended to. The journal is opened in append mode, so a
    // second run of the same scenario lands behind the first and the analyser
    // reads both as one trajectory — which is how a three-call run and a
    // seven-call run were read as one ten-call run, and the conclusion drawn
    // from it was wrong in both directions.
    rmSync(tracePath, { force: true });
    const child = spawn(process.execPath, [join(ROOT, 'scripts', 'cu-desktop-chain-real.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        CU_TARGET_APP: scenario.app,
        CU_TARGET_BUNDLE: scenario.bundle,
        CU_PROMPT: scenario.prompt,
        CU_USER_DATA_DIR: userDataDir,
        // The presentation checks — the mirror, the cursor — are evidence of a
        // dispatch, so they can only be asserted where one is expected. A task
        // the model is expected to refuse may reach that conclusion without
        // dispatching anything: measured on save-pdf, one run read the menu and
        // reported in three calls with nothing dispatched, the next tried
        // `cmd+p` first. `maybe` records what happened without grading it.
        CU_EXPECT_ACTION: scenario.readOnly ? '0' : scenario.expectRefusal ? 'maybe' : '1',
        ...(scenario.expectRefusal ? { CU_EXPECT_REFUSAL: '1' } : {}),
        // Every call the model made, arguments verbatim, results untruncated,
        // interleaved with the executor's dispatch trace. This is the record
        // the analyser reads: what the model asked for, what it got back, and
        // what it did next.
        MAKA_CU_DEBUG_LOG: tracePath,
      },
    });
    let out = '';
    child.stdout.on('data', (c) => {
      out += String(c);
      process.stdout.write(c);
    });
    child.stderr.on('data', (c) => {
      out += String(c);
      process.stderr.write(c);
    });
    child.on('close', (code) => resolve({ code, out }));
  });
}

const results = [];
for (const scenario of scenarios) {
  for (const model of MODELS) {
    console.log(`\n${'='.repeat(74)}`);
    console.log(`${scenario.key} × ${model} — 「${scenario.ask}」`);
    console.log(`expected to exercise: ${scenario.expect}`);
    console.log('='.repeat(74));

    let setup = {};
    try {
      // Reset for every model, not once per task: the second model must meet
      // the same starting state as the first, or the comparison is between a
      // clean run and somebody else's leftovers.
      setup = (await scenario.before?.()) ?? {};
    } catch (error) {
      console.log(`      setup failed: ${error.message}`);
    }

    const userDataDir = await mkdtemp(join(tmpdir(), `maka-scenario-${scenario.key}-`));
    try {
      await seedConnection(userDataDir, model);
    } catch (error) {
      console.log(`      could not configure ${model}: ${error.message}`);
      continue;
    }

    const { code, out } = await run(scenario, userDataDir, model);
    const checks = [...out.matchAll(/^\[(PASS|FAIL)\] (.+?)(?: — (.*))?$/gm)].map((m) => ({
      pass: m[1] === 'PASS',
      label: m[2],
      detail: m[3] ?? '',
    }));
    // What the attempt cost, reported rather than asserted: a task nobody can
    // do yet still has a better and a worse way of failing.
    const calls = [...out.matchAll(/操作电脑 (\d+) 次/g)].map((m) => Number(m[1]));
    const failedCalls = [...out.matchAll(/(\d+) 个失败/g)].map((m) => Number(m[1]));

    let witness = null;
    try {
      witness = (await scenario.verify?.(setup)) ?? null;
    } catch (error) {
      witness = { ok: false, detail: `witness failed: ${error.message}` };
    }
    if (witness) {
      console.log(
        `[${witness.ok ? 'DONE' : 'NOT DONE'}] the task, when somebody else looks — ${witness.detail}`,
      );
    }
    // After the witness, never before: cleanup that ran first would take away
    // the state the witness exists to read.
    await scenario.after?.(setup).catch?.(() => {});

    await writeFile(join(OUT, `${scenario.key}__${model}.log`), out);
    results.push({
      scenario,
      model,
      code,
      checks,
      witness,
      calls: calls.length > 0 ? Math.max(...calls) : 0,
      failedCalls: failedCalls.length > 0 ? Math.max(...failedCalls) : 0,
    });
  }
}

console.log(
  `\n${'='.repeat(74)}\nWHAT A PERSON ASKED FOR, AND WHAT EACH MODEL DID\n${'='.repeat(74)}`,
);
const tasks = [...new Set(results.map((r) => r.scenario.key))];
const models = [...new Set(results.map((r) => r.model))];
const w = Math.max(...tasks.map((t) => t.length), 12);
console.log(`${'task'.padEnd(w)}  ${models.map((m) => m.slice(0, 16).padEnd(16)).join(' ')}`);
console.log(`${'-'.repeat(w)}  ${models.map(() => '-'.repeat(16)).join(' ')}`);
for (const task of tasks) {
  const cells = models.map((model) => {
    const r = results.find((x) => x.scenario.key === task && x.model === model);
    if (!r) return '·'.padEnd(16);
    const done = r.witness ? (r.witness.ok ? 'done' : 'not done') : '—';
    return `${done} ${r.calls}c/${r.failedCalls}f`.padEnd(16);
  });
  console.log(`${task.padEnd(w)}  ${cells.join(' ')}`);
}
console.log(
  '\n(done = an independent reader saw the effect; Nc/Mf = N computer calls, M reported failed)',
);

const chainProblems = results.flatMap((r) =>
  r.checks.filter((c) => !c.pass).map((c) => `${r.scenario.key}×${r.model}: ${c.label}`),
);
if (chainProblems.length > 0) {
  console.log(`\nchain checks that failed:`);
  for (const line of [...new Set(chainProblems)]) console.log(`  ${line}`);
}

const done = results.filter((r) => r.witness?.ok).length;
console.log(
  `\n${done}/${results.length} attempts actually got the task done. The rest are the backlog, and the traces say why.`,
);
console.log(`logs and traces in ${OUT}`);
