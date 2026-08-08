import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, test } from 'node:test';
import type { ContaminationScanReport } from '../harness-contamination-scan.js';
import {
  appendScheduledCells,
  appendTrialCell,
  scheduledCellLogPath,
  trialCellLogPath,
} from '../trial-cell-log.js';
import { withCapturedProcessIo } from './helpers/capture-process-io.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = join(REPO_ROOT, 'packages/headless/harbor/run-contamination-scan.mjs');

/**
 * The upstream this run was graded against, read at run time rather than
 * written down.
 *
 * This file compiles into `dist`, which the Maka arm mounts. A revision or an
 * upstream URL spelled out here would be the leak the scan exists to find, so
 * it is loaded from the same host-only JSON the scan loads it from.
 */
async function benchmark(): Promise<{
  upstreamRepositoryUrl: string;
  revision: string;
  taskTreeFingerprint: string;
}> {
  const catalog = JSON.parse(
    await readFile(join(REPO_ROOT, 'packages/headless/harbor/benchmark-identity.json'), 'utf8'),
  ) as {
    terminalBench21: {
      upstreamRepositoryUrl: string;
      revision: string;
      taskTreeFingerprint: string;
    };
  };
  return catalog.terminalBench21;
}

interface Cell {
  agent: string;
  taskId: string;
  /** Absent means the cell recorded a row but never exported a trajectory. */
  messages?: string[];
}

/**
 * A run root the way the harness leaves one: the grid it scheduled, and the
 * cells it recorded. The arm ids come from the harness's own manifest builder,
 * so a test cannot agree with the scan about a composition neither shares with
 * the run.
 *
 * Every scheduled arm/task pair gets a recorded cell unless the caller asks
 * for it to be missing. A cell the caller did not describe is an ordinary
 * clean one: the background a finding needs to stand out against.
 */
async function withRunRoot<T>(
  cells: Cell[],
  fn: (runRoot: string, armIds: string[]) => Promise<T>,
  options: {
    unrecorded?: (agent: string, taskId: string) => boolean;
    /** Tasks the frozen manifest names that this run did not put on its schedule. */
    unscheduledManifestTaskIds?: string[];
  } = {},
): Promise<T> {
  const runRoot = await mkdtemp(join(tmpdir(), 'maka-contamination-cli-'));
  try {
    const { buildHarnessAbManifest } = (await import(
      new URL('../../harbor/run-harness-ab.mjs', import.meta.url).href
    )) as {
      buildHarnessAbManifest: (input: Record<string, unknown>) => { arms: { id: string }[] };
    };
    const taskIds = [...new Set(cells.map((cell) => cell.taskId))];
    const manifestTaskIds = [...taskIds, ...(options.unscheduledManifestTaskIds ?? [])];
    const manifest = buildHarnessAbManifest({
      subjectFingerprint: 'subject',
      taskSourceFingerprint: 'tasks',
      toolchainFingerprint: 'tools',
      ...(manifestTaskIds.length > 0 ? { taskIds: manifestTaskIds } : {}),
    });
    await writeFile(join(runRoot, 'harness-ab-manifest.json'), JSON.stringify(manifest), 'utf8');
    const armIds = manifest.arms.map((arm) => arm.id);
    await appendScheduledCells(
      scheduledCellLogPath(runRoot),
      armIds.flatMap((agent) => taskIds.map((taskId) => ({ agent, taskId }))),
    );
    const grid = armIds.flatMap((agent) =>
      taskIds.map((taskId) => {
        const described = cells.find((cell) => cell.agent === agent && cell.taskId === taskId);
        return described ?? { agent, taskId, messages: ['ran the tests, 12 passed'] };
      }),
    );
    for (const [index, cell] of grid.entries()) {
      if (options.unrecorded?.(cell.agent, cell.taskId)) continue;
      const trialDir = join(runRoot, 'jobs', `${cell.agent}-${index}`, 'trial');
      await mkdir(join(trialDir, 'agent'), { recursive: true });
      if (cell.messages) {
        await writeFile(
          join(trialDir, 'agent', 'trajectory.json'),
          JSON.stringify({
            steps: cell.messages.map((message, step) => ({ step_id: step + 1, message })),
          }),
          'utf8',
        );
      }
      await appendTrialCell(trialCellLogPath(runRoot), {
        runId: 'run-1',
        roundId: `${cell.agent}-r0-${cell.taskId}`,
        taskId: cell.taskId,
        agent: cell.agent,
        trialDir,
      });
    }
    return await fn(runRoot, armIds);
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
}

/**
 * The script's exported entry, invoked in process with the executable
 * footer's contract mirrored exactly: a thrown error lands on stderr and
 * exits 2. The real-subprocess route stays in 'refuses an invocation it
 * cannot act on' as the representative coverage of that footer itself.
 */
async function runScanScript(
  argv: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { main } = (await import(
    new URL('../../harbor/run-contamination-scan.mjs', import.meta.url).href
  )) as { main: (argv?: string[]) => Promise<number> };
  const {
    result: code,
    stdout,
    stderr,
  } = await withCapturedProcessIo(async () => {
    try {
      return await main(argv);
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? String(error)) : String(error)}\n`,
      );
      return 2;
    }
  });
  return { code, stdout, stderr };
}

async function scan(runRoot: string): Promise<{ code: number; report: ContaminationScanReport }> {
  const jsonPath = join(runRoot, 'report.json');
  const { code } = await runScanScript(['--run-root', runRoot, '--json', jsonPath]);
  return { code, report: JSON.parse(await readFile(jsonPath, 'utf8')) as ContaminationScanReport };
}

describe('run-contamination-scan', () => {
  test('exits zero only after actually searching cells and finding nothing', async () => {
    await withRunRoot(
      [{ agent: 'maka', taskId: 'cobol-modernization', messages: ['ran the tests, 12 passed'] }],
      async (runRoot, armIds) => {
        const { code, report } = await scan(runRoot);
        assert.equal(code, 0);
        assert.equal(report.totals.analyzed, armIds.length);
        assert.deepEqual(report.unrecordedCells, []);
      },
    );
  });

  // Each retrieval signal separately, through the real exit code. One of them
  // standing in for the other two would let a change that quietly demotes a
  // pinned revision to advisory pass everything but a single unit assertion.
  describe('exits non-zero on evidence a cell went and got the benchmark', () => {
    for (const [label, evidence] of [
      [
        'the upstream repository',
        async () => `git clone ${(await benchmark()).upstreamRepositoryUrl}.git`,
      ],
      [
        'the pinned revision',
        async () => `checked out ${(await benchmark()).revision.slice(0, 12)}`,
      ],
      [
        'the task-tree fingerprint',
        async () => `tree ${(await benchmark()).taskTreeFingerprint.replace(/^sha256:/, '')}`,
      ],
    ] as const) {
      test(label, async () => {
        const message = await evidence();
        await withRunRoot(
          [{ agent: 'maka', taskId: 'cobol-modernization', messages: [message] }],
          async (runRoot) => {
            const { code, report } = await scan(runRoot);
            assert.equal(code, 1);
            assert.equal(report.totals.cellsWithRetrievalSignals, 1);
          },
        );
      });
    }
  });

  test('writes the report where it was asked to', async () => {
    await withRunRoot(
      [{ agent: 'maka', taskId: 'cobol-modernization', messages: ['ran the tests'] }],
      async (runRoot, armIds) => {
        const markdownPath = join(runRoot, 'report.md');
        const { code } = await runScanScript(['--run-root', runRoot, '--markdown', markdownPath]);
        assert.equal(code, 0);
        assert.match(
          await readFile(markdownPath, 'utf8'),
          new RegExp(`Searched ${armIds.length} of ${armIds.length} recorded cells\\.`),
        );
      },
    );
  });

  test('refuses a flag it does not know', async () => {
    const { code } = await runScanScript(['--run-root', '/tmp', '--depth', '2']);
    assert.equal(code, 2);
  });

  // A cell whose trajectory never landed was not searched, and a zero exit here
  // would be a verdict on evidence that does not exist.
  test('exits non-zero when a declared cell could not be searched', async () => {
    await withRunRoot([{ agent: 'maka', taskId: 'cobol-modernization' }], async (runRoot) => {
      const { code, report } = await scan(runRoot);
      assert.equal(code, 1);
      assert.equal(report.coverageByAgent.maka?.analyzed, 0);
      assert.deepEqual(report.unrecordedCells, []);
    });
  });

  // Every cell the run declared is missing. Nothing was searched, and the
  // report says so rather than certifying the empty set.
  test('exits non-zero on a run in which nothing was read at all', async () => {
    await withRunRoot(
      [{ agent: 'maka', taskId: 'cobol-modernization', messages: ['ran the tests'] }],
      async (runRoot, armIds) => {
        const { code, report } = await scan(runRoot);
        assert.equal(code, 1);
        assert.equal(report.totals.cells, 0);
        assert.equal(report.unrecordedCells.length, armIds.length);
      },
      { unrecorded: () => true },
    );
  });

  // Every recorded cell was searched and came back clean, so nothing but the
  // missing cells stands between this run and a zero exit. A run killed part
  // way through looks exactly like this.
  test('exits non-zero when the run declared cells it never recorded', async () => {
    await withRunRoot(
      [{ agent: 'maka', taskId: 'cobol-modernization', messages: ['ran the tests, 12 passed'] }],
      async (runRoot, armIds) => {
        const { code, report } = await scan(runRoot);
        assert.equal(code, 1);
        assert.equal(report.totals.cells, report.totals.analyzed);
        assert.equal(report.totals.cellsWithRetrievalSignals, 0);
        assert.deepEqual(
          report.unrecordedCells,
          armIds
            .filter((armId) => armId !== 'maka')
            .map((agent) => ({ agent, taskId: 'cobol-modernization' })),
        );
      },
      { unrecorded: (agent) => agent !== 'maka' },
    );
  });

  // A model can name this suite's tasks from what it read years ago. An alarm
  // that fires on that fires on every run.
  test('does not fail a run on a task-id mention alone', async () => {
    await withRunRoot(
      [
        {
          agent: 'maka',
          taskId: 'cobol-modernization',
          messages: ['this suite also has fix-git, as I recall'],
        },
      ],
      async (runRoot) => {
        const { code, report } = await scan(runRoot);
        assert.equal(code, 0);
        assert.equal(report.totals.cellsWithAdvisorySignalsOnly, 1);
      },
    );
  });

  // Not a verdict and not a stack trace: a run root with no scheduled-cell log
  // is either the wrong directory or a run that died before it scheduled, and
  // the two cannot be told apart from here.
  test('says what is missing when a run root is not one', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'maka-contamination-empty-'));
    try {
      const { code, stderr } = await runScanScript(['--run-root', empty]);
      assert.equal(code, 2);
      assert.match(stderr, /no schedule recorded at .*scheduled-cells\.jsonl/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  // A canary grades five of the benchmark's tasks and finishes. The frozen
  // manifest beside it still names all of them — it is the same file the full
  // run resumes against — so a scan that took the manifest for the schedule
  // would call every complete canary an unfinished run.
  test('passes a run that graded a slice of the benchmark and finished', async () => {
    await withRunRoot(
      [{ agent: 'maka', taskId: 'cobol-modernization', messages: ['ran the tests, 12 passed'] }],
      async (runRoot, armIds) => {
        const manifest = JSON.parse(
          await readFile(join(runRoot, 'harness-ab-manifest.json'), 'utf8'),
        ) as { evaluationTaskIds: string[] };
        assert.ok(manifest.evaluationTaskIds.length > 1, 'manifest must over-declare the schedule');
        const { code, report } = await scan(runRoot);
        assert.equal(code, 0);
        assert.deepEqual(report.unrecordedCells, []);
        assert.equal(report.totals.analyzed, armIds.length);
      },
      { unscheduledManifestTaskIds: ['fix-git', 'raman-fitting'] },
    );
  });

  // A crash during the very first schedule row leaves the file present and
  // empty. Reading that as "this run scheduled nothing" would make every cell
  // it went on to grade unaccounted for and still certify the run.
  test('refuses a schedule that names no cells', async () => {
    const runRoot = await mkdtemp(join(tmpdir(), 'maka-contamination-torn-'));
    try {
      await writeFile(scheduledCellLogPath(runRoot), '', 'utf8');
      const { code, stderr } = await runScanScript(['--run-root', runRoot]);
      assert.equal(code, 2);
      assert.match(stderr, /names no cells/);
    } finally {
      await rm(runRoot, { recursive: true, force: true });
    }
  });

  test('refuses an invocation it cannot act on', async () => {
    await assert.rejects(execFileAsync(process.execPath, [SCRIPT]), (error: { code?: number }) => {
      assert.equal(error.code, 2);
      return true;
    });
  });
});
