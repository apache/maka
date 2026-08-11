#!/usr/bin/env node
/**
 * PR-DESKTOP-SMOKE-0: real Electron window smoke runner.
 *
 * This is intentionally a human-in-the-loop gate. Automated fixtures
 * cannot verify native macOS resize hit areas, titlebar drag, or keyboard
 * traversal through a live Electron window. This script launches a clean,
 * isolated Maka window and records the reviewer-confirmed result as JSON +
 * Markdown under `apps/desktop/tests/real-window-smoke/`.
 */

import { execFile, spawn } from 'node:child_process';
import { terminateChildProcessTree } from '@maka/runtime/process-tree-terminator';
import { closeElectronApplication } from './electron-lifecycle.mjs';
import { buildFixtureEnv } from './fixture-env.mjs';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import os from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const DESKTOP_DIR = join(REPO_ROOT, 'apps', 'desktop');
const REPORT_DIR = join(DESKTOP_DIR, 'tests', 'real-window-smoke');
const DEFAULT_SCENARIO = 'sidebar-search-modal-open';
const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 840;
const DEFAULT_DIAGNOSTIC_WAIT_MS = 3500;

export const PROGRAMMATIC_SMOKE_CHECKS = [
  {
    id: 'programmatic-window-visible',
    prompt: 'BrowserWindow exists, is visible, and matches the requested smoke bounds.',
  },
  {
    id: 'programmatic-window-flags',
    prompt: 'BrowserWindow reports resizable + movable through Electron APIs.',
  },
  {
    id: 'programmatic-renderer-mounted',
    prompt: 'Renderer app frame is mounted and document.readyState is complete.',
  },
  {
    id: 'programmatic-search-modal-open',
    prompt: 'Search modal and backdrop mount in the deterministic smoke fixture.',
  },
  {
    id: 'programmatic-focus-target',
    prompt: 'Search modal receives focus on an interactive control after modal open.',
  },
  {
    id: 'programmatic-no-error-boundary',
    prompt: 'Renderer does not show the React ErrorBoundary surface.',
  },
  {
    id: 'programmatic-dock-visible',
    prompt:
      'macOS: the app keeps its Dock tile, so a reviewer who switches away can switch back via Dock or Cmd+Tab.',
  },
];

const STARTUP_SMOKE_CHECKS = [
  {
    id: 'startup-window-ready',
    prompt: 'The real Maka BrowserWindow and renderer reach a usable ready state.',
  },
];

export const REAL_WINDOW_SMOKE_CHECKS = [
  {
    id: 'launch-clean-window',
    prompt:
      'The app launches a real Electron window from a clean smoke user-data dir, with no ErrorBoundary/crash screen.',
  },
  {
    id: 'resize-left-edge',
    prompt: 'Dragging the left window edge resizes the window.',
  },
  {
    id: 'resize-right-edge',
    prompt: 'Dragging the right window edge resizes the window.',
  },
  {
    id: 'resize-top-edge',
    prompt: 'Dragging the top window edge resizes the window.',
  },
  {
    id: 'resize-bottom-edge',
    prompt: 'Dragging the bottom window edge resizes the window.',
  },
  {
    id: 'resize-corners',
    prompt: 'Dragging all four corners resizes diagonally.',
  },
  {
    id: 'titlebar-drag',
    prompt: 'Dragging an allowed titlebar/blank header region moves the window.',
  },
  {
    id: 'controls-no-drag',
    prompt: 'Sidebar rows, buttons, inputs, and modal controls do not drag the window.',
  },
  {
    id: 'search-modal-cycle',
    prompt: 'Search modal opens and closes with the close button, backdrop, and Escape.',
  },
  {
    id: 'keyboard-path',
    prompt:
      'Tab/Shift+Tab stays inside the active modal, Enter activates focused controls, and Escape returns focus to the trigger.',
  },
  {
    id: 'modal-resize-hit-area',
    prompt: 'With Search modal open, window edges/corners still resize.',
  },
  {
    id: 'renderer-health',
    prompt:
      'After closing the modal and switching sidebar modules, no ErrorBoundary or React hook error appears.',
  },
];

function parseArgs(argv) {
  const args = {
    scenario: DEFAULT_SCENARIO,
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    noLaunch: false,
    cleanupStale: true,
    assumeYes: false,
    failNote: null,
    unverifiedNote: null,
    diagnosticWaitMs: DEFAULT_DIAGNOSTIC_WAIT_MS,
    programmaticOnly: false,
    startupOnly: false,
    manual: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--scenario') args.scenario = argv[++i];
    else if (arg === '--width') args.width = Number(argv[++i]);
    else if (arg === '--height') args.height = Number(argv[++i]);
    else if (arg === '--no-launch') args.noLaunch = true;
    else if (arg === '--no-cleanup-stale') args.cleanupStale = false;
    else if (arg === '--yes') args.assumeYes = true;
    else if (arg === '--fail-note') args.failNote = argv[++i] ?? '';
    else if (arg === '--unverified-note') args.unverifiedNote = argv[++i] ?? '';
    else if (arg === '--diagnostic-wait-ms') args.diagnosticWaitMs = Number(argv[++i]);
    else if (arg === '--programmatic-only') args.programmaticOnly = true;
    else if (arg === '--startup-only') args.startupOnly = true;
    else if (arg === '--manual') args.manual = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else {
      console.error(`[real-window-smoke] unknown arg: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: desktop-real-window-smoke.mjs [--scenario name] [--width n] [--height n] [--no-launch] [--no-cleanup-stale] [--fail-note text] [--unverified-note text] [--diagnostic-wait-ms n] [--programmatic-only] [--startup-only] [--manual]

Launches a real Electron window with an isolated smoke workspace, then prompts
the reviewer to confirm native desktop behavior that screenshots cannot prove.

--manual launches the same window and stops there: no checklist, no report.
Use it to look at a fixture route in the running app — the window stays up
until you close it or press Ctrl-C.

Default scenario: ${DEFAULT_SCENARIO}
Report dir: ${relative(REPO_ROOT, REPORT_DIR)}
`);
}

function execFileText(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
      });
    });
  });
}

function parsePsOutput(stdout) {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!match) return null;
      return { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] };
    })
    .filter(Boolean);
}

function isStaleMakaElectronProcess(entry) {
  if (!entry || entry.pid === process.pid) return false;
  const command = entry.command;
  if (!command.includes('Electron.app/Contents/MacOS/Electron')) return false;
  if (!command.includes('--user-data-dir=')) return false;
  return (
    /--user-data-dir=(?:\/private)?\/tmp\/maka-(?:e2e-fixture|real-window-smoke|p0fix|uxp|v\d|copy|long|modal|narr|test-cap-debug)/.test(
      command,
    ) || /--user-data-dir=(?:\/private)?\/var\/folders\/.+\/maka-real-window-smoke-/.test(command)
  );
}

async function listElectronRootProcesses() {
  const result = await execFileText('ps', ['-axo', 'pid,ppid,command']);
  if (!result.ok) return [];
  return parsePsOutput(result.stdout).filter((entry) =>
    entry.command.includes('Electron.app/Contents/MacOS/Electron'),
  );
}

async function cleanupStaleElectronProcesses(enabled) {
  if (!enabled) return [];
  const stale = (await listElectronRootProcesses()).filter(isStaleMakaElectronProcess);
  if (stale.length === 0) return [];
  console.log(
    `[real-window-smoke] cleaning ${stale.length} stale Maka Electron process(es): ${stale.map((entry) => entry.pid).join(', ')}`,
  );
  await Promise.all(stale.map((entry) => execFileText('kill', [String(entry.pid)])));
  await new Promise((resolve) => setTimeout(resolve, 750));
  const survivors = (await listElectronRootProcesses()).filter((entry) =>
    stale.some((staleEntry) => staleEntry.pid === entry.pid),
  );
  if (survivors.length > 0) {
    console.log(
      `[real-window-smoke] SIGKILL stale survivor(s): ${survivors.map((entry) => entry.pid).join(', ')}`,
    );
    await Promise.all(survivors.map((entry) => execFileText('kill', ['-9', String(entry.pid)])));
  }
  return stale.map(({ pid, ppid, command }) => ({ pid, ppid, command }));
}

async function ensureRepoRoot() {
  const pkg = join(REPO_ROOT, 'package.json');
  if (!existsSync(pkg)) {
    console.error(`[real-window-smoke] cannot locate repo root (no package.json at ${pkg})`);
    process.exit(2);
  }
  const root = JSON.parse(await readFile(pkg, 'utf8'));
  if (!root.workspaces || !Array.isArray(root.workspaces)) {
    console.error('[real-window-smoke] expected npm workspaces root; aborting.');
    process.exit(2);
  }
}

async function resolveElectronBin() {
  const electronModule = join(REPO_ROOT, 'node_modules', 'electron');
  if (!existsSync(electronModule)) {
    console.error('[real-window-smoke] electron not installed; run `npm install` first.');
    process.exit(2);
  }
  try {
    const exportPath = (await import('electron')).default;
    if (typeof exportPath === 'string') return exportPath;
  } catch (err) {
    console.error('[real-window-smoke] failed to resolve electron:', err);
    process.exit(2);
  }
  console.error('[real-window-smoke] electron resolved to a non-string path.');
  process.exit(2);
}

async function launchElectron(args, diagnostics) {
  if (args.noLaunch) return null;
  const electronBin = await resolveElectronBin();
  const userDataDir = join(os.tmpdir(), `maka-real-window-smoke-${args.scenario}-${process.pid}`);
  const homeDir = join(userDataDir, 'home');
  await mkdir(homeDir, { recursive: true });
  // The shared builder, not a hand-rolled `{ ...process.env }`: this gate was
  // the last launcher still inheriting the environment wholesale, which meant
  // a developer with `npm run dev` open smoked the dev server instead of the
  // build this script just made (VITE_DEV_SERVER_URL), and the run touched
  // the real $HOME. A fixture window also starts hidden for its whole
  // lifecycle (`startHidden` in `main.ts`), which leaves this gate with
  // nothing to look at — showWindow opts this run back into a visible window,
  // and the dock rule follows it.
  const env = buildFixtureEnv(userDataDir, homeDir, {
    scenario: args.startupOnly ? undefined : args.scenario,
    showWindow: true,
  });
  env.MAKA_E2E_FIXTURE_WIDTH = String(args.width);
  env.MAKA_E2E_FIXTURE_HEIGHT = String(args.height);
  env.MAKA_REAL_WINDOW_SMOKE = '1';
  const launchArgs = ['.', `--user-data-dir=${userDataDir}`];
  const child = spawn(electronBin, launchArgs, {
    cwd: DESKTOP_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Group leader, like every runtime spawn: the shared tree terminator
    // kills by process group (`kill(-pid)`), which only lands when the child
    // owns its group. A visible Electron ignores SIGTERM, so this launcher
    // depends on that escalation actually working.
    detached: process.platform !== 'win32',
  });
  const launchCommand = `${electronBin} ${launchArgs.join(' ')}`;
  diagnostics.launch = {
    command: launchCommand,
    cwd: DESKTOP_DIR,
    electronPid: child.pid ?? null,
    userDataDir,
  };
  let stdoutBuffer = '';
  const diagnosticWaiters = [];
  diagnostics.windowDiagnostics = [];
  console.log(
    `[real-window-smoke] launched Electron pid=${child.pid ?? 'unknown'} userDataDir=${userDataDir}`,
  );
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    process.stdout.write(chunk);
    stdoutBuffer += text;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '[startup] app ready') {
        diagnostics.startupReady = true;
        for (const waiter of [...diagnosticWaiters]) {
          if (waiter.stage === 'app-ready') waiter.finish(true);
        }
      }
      const match = /^\[real-window-smoke\] diagnostic (.+)$/.exec(line.trim());
      if (!match) continue;
      try {
        const diagnostic = JSON.parse(match[1]);
        diagnostics.windowDiagnostics.push(diagnostic);
        for (const waiter of [...diagnosticWaiters]) {
          if (waiter.stage === diagnostic.stage) waiter.finish(true);
        }
      } catch {
        diagnostics.windowDiagnostics.push({ parseError: line.trim() });
      }
    }
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  child.on('exit', (code, signal) => {
    if (code !== null) console.log(`[real-window-smoke] Electron exited with code ${code}`);
    else if (signal) console.log(`[real-window-smoke] Electron exited via ${signal}`);
  });
  return {
    child,
    userDataDir,
    command: launchCommand,
    electronPid: child.pid ?? null,
    waitForDiagnostics: (timeoutMs = 1500, stage = 'settled-1000ms') => {
      if (stage === 'app-ready' && diagnostics.startupReady) return Promise.resolve(true);
      if (diagnostics.windowDiagnostics.some((entry) => entry.stage === stage)) {
        return Promise.resolve(true);
      }
      return new Promise((resolveDiagnostic) => {
        const finish = (observed) => {
          clearTimeout(timeout);
          const index = diagnosticWaiters.indexOf(waiter);
          if (index >= 0) diagnosticWaiters.splice(index, 1);
          resolveDiagnostic(observed);
        };
        const timeout = setTimeout(() => finish(false), Math.max(0, timeoutMs));
        const waiter = { stage, finish };
        diagnosticWaiters.push(waiter);
      });
    },
  };
}

async function promptChecks(args) {
  if (args.unverifiedNote !== null) {
    const note =
      args.unverifiedNote.trim() ||
      'real-window smoke could not verify the live window in this environment';
    return REAL_WINDOW_SMOKE_CHECKS.map((check) => ({
      ...check,
      status: 'UNVERIFIED',
      ok: false,
      note,
    }));
  }
  if (args.failNote !== null) {
    const note =
      args.failNote.trim() || 'real-window smoke was explicitly marked as failed by the reviewer';
    return REAL_WINDOW_SMOKE_CHECKS.map((check) => ({ ...check, status: 'FAIL', ok: false, note }));
  }
  const rl = createInterface({ input, output });
  const results = [];
  try {
    for (const check of REAL_WINDOW_SMOKE_CHECKS) {
      if (args.assumeYes) {
        results.push({ ...check, status: 'PASS', ok: true, note: 'auto-confirmed by --yes' });
        continue;
      }
      let answer = '';
      while (!/^(y|yes|n|no)$/i.test(answer.trim())) {
        answer = await rl.question(`[real-window-smoke] ${check.prompt} (y/n): `);
      }
      const ok = /^(y|yes)$/i.test(answer.trim());
      let note = '';
      if (!ok) {
        note = await rl.question('[real-window-smoke] Failure note (what failed / where): ');
      }
      results.push({ ...check, status: ok ? 'PASS' : 'FAIL', ok, note });
    }
  } finally {
    rl.close();
  }
  return results;
}

function latestWindowDiagnostic(diagnostics) {
  const entries = diagnostics.windowDiagnostics ?? [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry && entry.windowExists) return entry;
  }
  return null;
}

function buildProgrammaticResults(args, diagnostics) {
  const diagnostic = latestWindowDiagnostic(diagnostics);
  const renderer = diagnostic?.renderer ?? {};
  const expectedWidth = Math.floor(args.width);
  const expectedHeight = Math.floor(args.height);
  const bounds = diagnostic?.bounds;
  const checks = [
    {
      check: PROGRAMMATIC_SMOKE_CHECKS[0],
      ok: Boolean(
        diagnostic?.windowExists &&
          diagnostic.isVisible === true &&
          bounds?.width === expectedWidth &&
          bounds?.height === expectedHeight,
      ),
      note: diagnostic
        ? `visible=${diagnostic.isVisible} bounds=${JSON.stringify(bounds)} expected=${expectedWidth}x${expectedHeight}`
        : 'no BrowserWindow diagnostic was captured',
    },
    {
      check: PROGRAMMATIC_SMOKE_CHECKS[1],
      ok: diagnostic?.isResizable === true && diagnostic?.isMovable === true,
      note: diagnostic
        ? `isResizable=${diagnostic.isResizable} isMovable=${diagnostic.isMovable}`
        : 'no BrowserWindow diagnostic was captured',
    },
    {
      check: PROGRAMMATIC_SMOKE_CHECKS[2],
      ok: renderer.readyState === 'complete' && renderer.appFramePresent === true,
      note: `readyState=${renderer.readyState ?? 'unknown'} appFramePresent=${renderer.appFramePresent ?? 'unknown'}`,
    },
    {
      check: PROGRAMMATIC_SMOKE_CHECKS[3],
      ok: renderer.searchModalPresent === true && renderer.searchModalOpen === true,
      note: `searchModalPresent=${renderer.searchModalPresent ?? 'unknown'} open=${renderer.searchModalOpen ?? 'unknown'}`,
    },
    {
      check: PROGRAMMATIC_SMOKE_CHECKS[4],
      // Focus must land on a control trapped inside the search modal. Check
      // this structurally (activeElement is inside the stable search-modal
      // contract root) rather
      // than by a class on the focused element — the autocomplete input's
      // implementation class is not part of this diagnostic contract.
      ok:
        renderer.activeElementInSearchModal === true &&
        (renderer.activeElement?.tagName === 'INPUT' ||
          renderer.activeElement?.tagName === 'BUTTON'),
      note: `activeElementInSearchModal=${renderer.activeElementInSearchModal ?? 'unknown'} activeElement=${JSON.stringify(renderer.activeElement ?? null)}`,
    },
    {
      check: PROGRAMMATIC_SMOKE_CHECKS[5],
      ok: renderer.errorBoundaryPresent === false,
      note: `errorBoundaryPresent=${renderer.errorBoundaryPresent ?? 'unknown'}`,
    },
    {
      check: PROGRAMMATIC_SMOKE_CHECKS[6],
      // Only macOS has a dock; elsewhere the diagnostic reports null and the
      // check is vacuously satisfied.
      ok: process.platform !== 'darwin' || diagnostic?.dockVisible === true,
      note:
        process.platform === 'darwin'
          ? `dockVisible=${diagnostic?.dockVisible ?? 'unknown'}`
          : `skipped on ${process.platform}`,
    },
  ];
  return checks.map(({ check, ok, note }) => ({
    ...check,
    layer: 'programmatic',
    status: ok ? 'PASS' : 'FAIL',
    ok,
    note,
  }));
}

function buildStartupResults(diagnostics) {
  const diagnostic = latestWindowDiagnostic(diagnostics);
  const renderer = diagnostic?.renderer ?? {};
  const ok = Boolean(
    diagnostics.startupReady === true &&
      diagnostic?.stage === 'settled-1000ms' &&
      diagnostic.windowExists === true &&
      diagnostic.isVisible === true &&
      renderer.readyState === 'complete' &&
      renderer.appFramePresent === true &&
      renderer.errorBoundaryPresent === false,
  );
  return [
    {
      check: STARTUP_SMOKE_CHECKS[0],
      ok,
      note: [
        `appReady=${diagnostics.startupReady === true}`,
        `stage=${diagnostic?.stage ?? 'missing'}`,
        `windowExists=${diagnostic?.windowExists ?? false}`,
        `visible=${diagnostic?.isVisible ?? false}`,
        `readyState=${renderer.readyState ?? 'missing'}`,
        `appFramePresent=${renderer.appFramePresent ?? false}`,
        `errorBoundaryPresent=${renderer.errorBoundaryPresent ?? 'missing'}`,
      ].join(' '),
    },
  ].map(({ check, ok, note }) => ({
    ...check,
    layer: 'startup',
    status: ok ? 'PASS' : 'FAIL',
    ok,
    note,
  }));
}

function buildUnverifiedOsHitTestResults(args) {
  const note =
    args.unverifiedNote?.trim() ||
    'OS hit-test requires Computer Use / real mouse access and was not verified in this run';
  return REAL_WINDOW_SMOKE_CHECKS.map((check) => ({
    ...check,
    layer: 'os-hit-test',
    status: 'UNVERIFIED',
    ok: false,
    note,
  }));
}

async function writeReport(args, launchInfo, results, diagnostics) {
  await mkdir(REPORT_DIR, { recursive: true });
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const git = await readGitHead();
  const status = deriveReportStatus(results);
  const ok = status === 'PASS';
  const report = {
    ok,
    status,
    createdAt: now.toISOString(),
    git,
    scenario: args.scenario,
    viewport: { width: args.width, height: args.height },
    platform: `${os.platform()} ${os.arch()} ${os.release()}`,
    userDataDir: launchInfo?.userDataDir ?? null,
    diagnostics,
    checks: results.map(({ id, layer, prompt, status: resultStatus, ok: resultOk, note }) => ({
      id,
      layer,
      prompt,
      status: resultStatus ?? (resultOk ? 'PASS' : 'FAIL'),
      ok: resultOk,
      note,
    })),
  };
  const jsonPath = join(REPORT_DIR, `${stamp}.json`);
  const mdPath = join(REPORT_DIR, `${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(mdPath, renderMarkdown(report));
  console.log(`[real-window-smoke] report: ${relative(REPO_ROOT, mdPath)}`);
  return report;
}

function deriveReportStatus(results) {
  if (results.every((result) => result.status === 'PASS' || result.ok === true)) {
    return 'PASS';
  }
  if (results.every((result) => result.status === 'PASS' || result.status === 'UNVERIFIED')) {
    return 'UNVERIFIED';
  }
  return 'FAIL';
}

async function readGitHead() {
  try {
    const { execFile } = await import('node:child_process');
    return await new Promise((resolve) => {
      execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT }, (err, stdout) => {
        resolve(err ? 'unknown' : stdout.trim());
      });
    });
  } catch {
    return 'unknown';
  }
}

function renderMarkdown(report) {
  const lines = [
    '# Maka Real Window Smoke Report',
    '',
    `- Result: ${report.status}`,
    `- Created: ${report.createdAt}`,
    `- Git: ${report.git}`,
    `- Scenario: ${report.scenario}`,
    `- Viewport: ${report.viewport.width}x${report.viewport.height}`,
    `- Platform: ${report.platform}`,
    report.userDataDir
      ? `- User data dir: \`${report.userDataDir}\``
      : '- User data dir: not launched by script',
    report.diagnostics?.launch?.electronPid
      ? `- Electron PID: ${report.diagnostics.launch.electronPid}`
      : '- Electron PID: not launched by script',
    report.diagnostics?.launch?.command
      ? `- Launch command: \`${escapeMd(report.diagnostics.launch.command)}\``
      : '- Launch command: not launched by script',
    `- Stale Electron processes cleaned: ${report.diagnostics?.staleElectronProcesses?.length ?? 0}`,
    `- Window diagnostics captured: ${report.diagnostics?.windowDiagnostics?.length ?? 0}`,
    '',
    '| Check | Result | Note |',
    '|---|---|---|',
  ];
  for (const check of report.checks) {
    lines.push(
      `| ${check.id} | ${check.status ?? (check.ok ? 'PASS' : 'FAIL')} | ${escapeMd(check.note || check.prompt)} |`,
    );
  }
  const programmaticChecks = report.checks.filter((check) => check.layer === 'programmatic');
  const osHitTestChecks = report.checks.filter((check) => check.layer === 'os-hit-test');
  if (programmaticChecks.length > 0 || osHitTestChecks.length > 0) {
    lines.push('', '## Layer Summary', '');
    if (programmaticChecks.length > 0) {
      lines.push(`- Programmatic: ${summarizeLayer(programmaticChecks)}`);
    }
    if (osHitTestChecks.length > 0) {
      lines.push(`- OS hit-test: ${summarizeLayer(osHitTestChecks)}`);
    }
  }
  if ((report.diagnostics?.windowDiagnostics?.length ?? 0) > 0) {
    lines.push('', '## Window Diagnostics', '');
    for (const diagnostic of report.diagnostics.windowDiagnostics) {
      lines.push(`\`\`\`json\n${JSON.stringify(diagnostic, null, 2)}\n\`\`\``);
    }
  }
  if ((report.diagnostics?.staleElectronProcesses?.length ?? 0) > 0) {
    lines.push('', '## Cleaned Stale Electron Processes', '');
    for (const processInfo of report.diagnostics.staleElectronProcesses) {
      lines.push(
        `- pid=${processInfo.pid} ppid=${processInfo.ppid} command=\`${escapeMd(processInfo.command)}\``,
      );
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function summarizeLayer(checks) {
  if (checks.every((check) => check.status === 'PASS')) return 'PASS';
  if (checks.some((check) => check.status === 'FAIL')) return 'FAIL';
  return 'UNVERIFIED';
}

function escapeMd(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

// Bounded stop through the shared Electron lifecycle owner: SIGTERM as the
// graceful close, then the same 5s-grace → SIGKILL-the-tree escalation every
// other launcher uses. A wedged Electron must cost seconds, not a hung gate.
async function stopElectron(child) {
  try {
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') {
        await terminateChildProcessTree(child, 'SIGKILL');
        await new Promise((resolveExit) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolveExit();
            return;
          }
          const timeout = setTimeout(resolveExit, 2_000);
          child.once('exit', () => {
            clearTimeout(timeout);
            resolveExit();
          });
        });
        if (child.exitCode === null && child.signalCode === null) {
          throw new Error('Electron process tree did not exit after taskkill');
        }
        return;
      }
      await closeElectronApplication(
        {
          close: () =>
            new Promise((resolve) => {
              child.once('exit', resolve);
              child.kill('SIGTERM');
            }),
          process: () => child,
        },
        5_000,
      );
    }
  } finally {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
}

// Launch-only mode. The checklist and the report belong to the smoke gate;
// looking at a route in the running app needs neither, and a migration that
// must stay visually neutral needs to look constantly. Same launch path as
// the gate, so the window a reviewer inspects is the window the gate checks.
async function runManualLaunch(args, diagnostics) {
  console.log(
    `[real-window-smoke] manual launch: scenario=${args.scenario} viewport=${args.width}x${args.height}`,
  );
  const launchInfo = await launchElectron(args, diagnostics);
  if (!launchInfo?.child) {
    console.error('[real-window-smoke] manual launch requires a window; --no-launch is redundant.');
    process.exit(2);
  }
  console.log('[real-window-smoke] close the window or press Ctrl-C to stop it.');
  await new Promise((resolve) => {
    const stop = () => {
      void stopElectron(launchInfo.child);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    launchInfo.child.on('exit', resolve);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }
  await ensureRepoRoot();
  const diagnostics = {
    argv: process.argv.slice(2),
    staleElectronProcesses: await cleanupStaleElectronProcesses(args.cleanupStale),
  };
  if (args.manual) {
    await runManualLaunch(args, diagnostics);
    return;
  }
  console.log('[real-window-smoke] This gate requires a human to test native window behavior.');
  console.log(
    '[real-window-smoke] Build first via `npm --workspace @maka/desktop run smoke:real-window`.',
  );
  console.log(
    `[real-window-smoke] scenario=${args.scenario} viewport=${args.width}x${args.height}`,
  );
  const launchInfo = await launchElectron(args, diagnostics);
  let report;
  try {
    if (launchInfo?.waitForDiagnostics) {
      await launchInfo.waitForDiagnostics(
        Number.isFinite(args.diagnosticWaitMs) ? args.diagnosticWaitMs : 1500,
        'settled-1000ms',
      );
      diagnostics.windowDiagnosticObserved = (diagnostics.windowDiagnostics?.length ?? 0) > 0;
    }
    const programmaticResults = args.startupOnly
      ? buildStartupResults(diagnostics)
      : buildProgrammaticResults(args, diagnostics);
    const results =
      args.programmaticOnly || args.startupOnly
        ? programmaticResults
        : [
            ...programmaticResults,
            ...(args.unverifiedNote !== null
              ? buildUnverifiedOsHitTestResults(args)
              : await promptChecks(args)),
          ];
    report = await writeReport(args, launchInfo, results, diagnostics);
  } finally {
    // Reclaim the window even when a later step throws — a failed report
    // write must not leave a live Electron behind.
    try {
      if (launchInfo?.child) await stopElectron(launchInfo.child);
    } finally {
      if (args.startupOnly && launchInfo?.userDataDir) {
        await rm(launchInfo.userDataDir, { recursive: true, force: true });
      }
    }
  }
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[real-window-smoke] fatal:', err);
    process.exit(1);
  });
}
