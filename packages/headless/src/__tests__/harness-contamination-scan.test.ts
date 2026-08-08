import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';
import {
  flattenBenchmarkIdentity,
  isRetrievalSignal,
  LABELLING_AGENT,
  MIN_REVISION_PREFIX,
  scanRunForContamination,
  scanTrajectory,
  TRAJECTORY_ARTIFACT_KIND_FULL,
  TRAJECTORY_ARTIFACT_KIND_KEY,
  TRAJECTORY_ARTIFACT_KIND_SUMMARY,
  TRAJECTORY_SUMMARY_REASON_KEY,
  type BenchmarkIdentity,
  type ContaminationSignalKind,
} from '../harness-contamination-scan.js';
import { appendTrialCell, trialCellLogPath } from '../trial-cell-log.js';

const execFileAsync = promisify(execFile);
const HARBOR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'harbor');

const identity: BenchmarkIdentity = {
  upstreamRepositoryUrls: ['https://github.com/example-org/example-bench-2-1'],
  revisions: ['0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d'],
  taskTreeFingerprints: ['sha256:0000111122223333444455556666777788889999aaaabbbbccccddddeeeeffff'],
  taskIds: ['cobol-modernization', 'fix-git', 'install-windows-3.11'],
};

function trajectory(messages: string[], extra?: Record<string, unknown>): unknown {
  return {
    steps: messages.map((message, index) => ({ step_id: index + 1, source: 'agent', message })),
    ...(extra ? { extra } : {}),
  };
}

function kinds(messages: string[], ownTaskId = 'cobol-modernization'): ContaminationSignalKind[] {
  const result = scanTrajectory({ trajectory: trajectory(messages), ownTaskId, identity });
  assert.equal(result.analyzed, true);
  return result.signals.map((signal) => signal.kind);
}

describe('benchmark identity', () => {
  test('flattens every profile the catalog carries into one set of needles', async () => {
    const catalog = JSON.parse(
      await readFile(join(HARBOR_DIR, 'benchmark-identity.json'), 'utf8'),
    ) as Record<string, { upstreamRepositoryUrl: string }>;
    const flat = flattenBenchmarkIdentity(catalog);

    assert.deepEqual(
      [...flat.upstreamRepositoryUrls].sort(),
      [
        catalog.deepSwe!.upstreamRepositoryUrl,
        catalog.terminalBench21!.upstreamRepositoryUrl,
      ].sort(),
    );
    // Terminal-Bench's tree plus DeepSWE's two subsets: a scan that took one
    // profile's fingerprint would go looking for two thirds of the evidence.
    assert.equal(flat.taskTreeFingerprints.length, 3);
    assert.equal(flat.revisions.length, 2);
    // Both benchmarks' task lists, deduplicated across the overlapping subsets.
    assert.ok(flat.taskIds.includes('cobol-modernization'));
    assert.ok(flat.taskIds.includes('dasel-html-document-format'));
    assert.equal(new Set(flat.taskIds).size, flat.taskIds.length);
  });

  // The catalog is nested by benchmark and by profile today; a profile list is
  // the shape it grows into, and a walker that stopped at an array would lose
  // every needle inside one without the guard noticing, because the families
  // outside it stay populated.
  test('walks a catalog whose profiles are held in an array', () => {
    const flat = flattenBenchmarkIdentity({
      bench: {
        profiles: [
          {
            upstreamRepositoryUrl: 'https://github.com/example-org/example-bench-2-1',
            revision: '0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d',
            taskTreeFingerprint: 'sha256:00001111',
            taskIds: ['a', 'b'],
          },
        ],
      },
    });
    assert.deepEqual(flat.taskIds, ['a', 'b']);
    assert.equal(flat.revisions.length, 1);
  });

  // The failure this guards is the quiet one: a renamed field turns every cell
  // clean, and a clean report is exactly what a reader wants to see. A partial
  // rename is quieter still, because the families that survived keep the report
  // looking whole.
  test('refuses a catalog that lost the revision alone', () => {
    assert.throws(
      () =>
        flattenBenchmarkIdentity({
          bench: {
            upstreamRepositoryUrl: 'https://github.com/example-org/example-bench-2-1',
            commit: '0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d',
            taskTreeFingerprint: 'sha256:00001111',
            taskIds: ['a'],
          },
        }),
      /carries no revisions/,
    );
  });

  test('refuses a catalog that carries no needles', () => {
    assert.throws(
      () => flattenBenchmarkIdentity({ terminalBench21: { revision: 'abc' } }),
      /carries no upstreamRepositoryUrls, taskTreeFingerprints, taskIds/,
    );
  });
});

describe('scanTrajectory', () => {
  test('finds nothing in a cell that solved its own task', () => {
    assert.deepEqual(
      kinds([
        'Reading /app/task.md and porting the COBOL payroll routine.',
        'Running the test suite: 12 passed.',
      ]),
      [],
    );
  });

  test('finds the fingerprint written without the digest scheme', () => {
    const bare = identity.taskTreeFingerprints[0]!.replace(/^sha256:/, '');
    assert.deepEqual(kinds([`tree hash ${bare}`]), ['task_tree_fingerprint']);
  });

  // Seven hex characters occur inside other hashes. This one written down is
  // the signal; this one occurring inside an unrelated digest is not.
  test('does not read the revision out of the middle of another hash', () => {
    const prefix = identity.revisions[0]!.slice(0, MIN_REVISION_PREFIX);
    assert.deepEqual(kinds([`blob ff${prefix}aa`]), []);
    assert.deepEqual(kinds([`checked out ${prefix}`]), ['pinned_revision']);
  });

  test("does not flag the cell's own task id written in another case", () => {
    assert.deepEqual(kinds(['solving Cobol-Modernization']), []);
  });

  test('finds each of the four signals', () => {
    assert.deepEqual(kinds(['git clone https://github.com/example-org/example-bench-2-1']), [
      'upstream_repository',
    ]);
    assert.deepEqual(kinds(['checked out 0a1b2c3d4e5']), ['pinned_revision']);
    assert.deepEqual(
      kinds(['tree hash sha256:0000111122223333444455556666777788889999aaaabbbbccccddddeeeeffff']),
      ['task_tree_fingerprint'],
    );
    assert.deepEqual(kinds(['the suite also has fix-git']), ['foreign_task_id']);
  });

  // A cell that names its own task is describing its work, not reaching.
  test("does not count the cell's own task id as foreign", () => {
    assert.deepEqual(kinds(['solving cobol-modernization']), []);
  });

  test('reports the step and the surrounding text so a reviewer can go read it', () => {
    const result = scanTrajectory({
      trajectory: trajectory([
        'first step',
        'then: git clone https://github.com/example-org/example-bench-2-1.git /tmp/tb',
      ]),
      ownTaskId: 'cobol-modernization',
      identity,
    });
    assert.equal(result.signals[0]?.stepId, 2);
    assert.equal(result.signals[0]?.match, 'example-org/example-bench-2-1');
    assert.match(result.signals[0]?.excerpt ?? '', /git clone/);
  });

  describe('the repository is matched by the name a rewritten host cannot drop', () => {
    // Each of these reaches the same repository while dropping or replacing the
    // host, which is why the pair rather than the URL is what is searched for.
    for (const [label, text] of [
      ['the .git spelling', 'git clone https://github.com/example-org/example-bench-2-1.git'],
      ['ssh', 'git clone git@github.com:example-org/example-bench-2-1.git'],
      ['a raw host', 'curl https://raw.githubusercontent.com/example-org/example-bench-2-1/main/x'],
      ['an ip', 'curl http://140.82.121.4/example-org/example-bench-2-1/archive/main.tar.gz'],
      ['a mirror', 'git clone https://gitee.com/mirrors/example-org/example-bench-2-1'],
    ] as const) {
      test(label, () => {
        assert.deepEqual(kinds([text]), ['upstream_repository']);
      });
    }

    test('does not read a longer name as this one', () => {
      assert.deepEqual(kinds(['github.com/example-org/example-bench-2-1-extras']), []);
      assert.deepEqual(kinds(['github.com/not-example-org/example-bench-2-1']), []);
    });
  });

  describe('a task id is matched at its own boundaries', () => {
    test('a dotted task id is found where it is named', () => {
      assert.deepEqual(kinds(['see install-windows-3.11 for the trick']), ['foreign_task_id']);
    });

    // The dot at the end of a sentence belongs to the sentence.
    test('a task id ending a sentence is found', () => {
      assert.deepEqual(kinds(['the other one is fix-git.']), ['foreign_task_id']);
    });

    test('a longer id containing this one is not this one', () => {
      assert.deepEqual(kinds(['fix-github-actions']), []);
      assert.deepEqual(kinds(['install-windows-3.11.2-beta']), []);
    });

    // The left boundary is the other half of the same judgement, and a right
    // boundary alone would let every one of these through.
    test('an id that merely ends with this one is not this one', () => {
      assert.deepEqual(kinds(['xfix-git']), []);
      assert.deepEqual(kinds(['prefix.fix-git']), []);
      assert.deepEqual(kinds(['0fix-git']), []);
    });
  });

  describe('the revision prefix floor', () => {
    test('matches what git itself would have shown the cell', () => {
      assert.deepEqual(kinds([`rev ${identity.revisions[0]!.slice(0, MIN_REVISION_PREFIX)}`]), [
        'pinned_revision',
      ]);
      assert.deepEqual(
        kinds([`rev ${identity.revisions[0]!.slice(0, MIN_REVISION_PREFIX - 1)}`]),
        [],
      );
    });

    // The floor is not a taste: it is what `git rev-parse --short` abbreviates
    // to in a small repository, measured rather than remembered, because
    // `core.abbrev=auto` grows with object count and this repository is far
    // past the smallest case a cell could be looking at.
    test('is no longer than git abbreviates to in a fresh repository', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'maka-git-abbrev-'));
      try {
        await execFileAsync('git', ['init', '--quiet', dir]);
        await writeFile(join(dir, 'probe.txt'), 'contamination scan abbreviation probe\n', 'utf8');
        const { stdout: oid } = await execFileAsync('git', ['hash-object', '-w', 'probe.txt'], {
          cwd: dir,
        });
        const { stdout: short } = await execFileAsync('git', ['rev-parse', '--short', oid.trim()], {
          cwd: dir,
        });
        assert.ok(
          MIN_REVISION_PREFIX <= short.trim().length,
          `git abbreviates to ${short.trim().length}; the floor is ${MIN_REVISION_PREFIX}`,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  test('searches every string a step carries, not a chosen field', () => {
    const result = scanTrajectory({
      trajectory: {
        steps: [
          {
            step_id: 1,
            source: 'agent',
            action: {
              command: ['bash', '-lc', 'git clone git@github.com:example-org/example-bench-2-1'],
            },
            extra: { nested: { deeper: ['and again fix-git'] } },
          },
        ],
      },
      ownTaskId: 'cobol-modernization',
      identity,
    });
    assert.deepEqual(result.signals.map((signal) => signal.kind).sort(), [
      'foreign_task_id',
      'upstream_repository',
    ]);
  });

  test('separates evidence of reaching from evidence of knowing', () => {
    assert.equal(isRetrievalSignal('upstream_repository'), true);
    assert.equal(isRetrievalSignal('pinned_revision'), true);
    assert.equal(isRetrievalSignal('task_tree_fingerprint'), true);
    assert.equal(isRetrievalSignal('foreign_task_id'), false);
  });

  describe('a trajectory that cannot answer the question refuses instead of passing', () => {
    test('a degraded summary', () => {
      const result = scanTrajectory({
        trajectory: trajectory(['Maka trajectory summary: invocation finished'], {
          [TRAJECTORY_ARTIFACT_KIND_KEY]: TRAJECTORY_ARTIFACT_KIND_SUMMARY,
          [TRAJECTORY_SUMMARY_REASON_KEY]: 'runtime_event_schema_invalid',
        }),
        ownTaskId: 'cobol-modernization',
        identity,
      });
      assert.equal(result.analyzed, false);
      assert.match(result.notAnalyzedReason ?? '', /runtime_event_schema_invalid/);
    });

    test('a label this side does not recognize', () => {
      const result = scanTrajectory({
        trajectory: trajectory(['step'], { [TRAJECTORY_ARTIFACT_KIND_KEY]: 'partial' }),
        ownTaskId: 'cobol-modernization',
        identity,
      });
      assert.equal(result.analyzed, false);
      assert.match(result.notAnalyzedReason ?? '', /unrecognized/);
    });

    // `trajectory.json` holding `null` parses, and a scan that walked it would
    // find no steps, no signals, and file the cell under clean.
    test('a trajectory that is not an object at all', () => {
      for (const value of [null, 'a string', 42]) {
        const result = scanTrajectory({
          trajectory: value,
          ownTaskId: 'cobol-modernization',
          identity,
        });
        assert.equal(result.analyzed, false);
      }
    });

    test('no steps at all', () => {
      const result = scanTrajectory({
        trajectory: { steps: [] },
        ownTaskId: 'cobol-modernization',
        identity,
      });
      assert.equal(result.analyzed, false);
    });

    // Every other arm's trajectory comes from an upstream Harbor agent that has
    // no degraded mode and writes no label. Demanding one would file every
    // competitor cell under "broken export".
    test('but an unlabelled upstream trajectory is ordinary ATIF', () => {
      const result = scanTrajectory({
        trajectory: {
          agent: { name: 'codex' },
          ...(trajectory(['git clone https://github.com/example-org/example-bench-2-1']) as object),
        },
        ownTaskId: 'cobol-modernization',
        identity,
      });
      assert.equal(result.analyzed, true);
      assert.deepEqual(
        result.signals.map((signal) => signal.kind),
        ['upstream_repository'],
      );
    });

    // Maka always labels, so an unlabelled Maka trajectory is a label that went
    // missing, not an ordinary export. Read as ordinary ATIF it would come back
    // clean: the degraded shape carries two steps and no tool calls, so there
    // is nothing in it to match.
    test('an unlabelled trajectory from the arm that labels', () => {
      const result = scanTrajectory({
        trajectory: {
          agent: { name: LABELLING_AGENT },
          ...(trajectory(['Maka invocation completed']) as object),
        },
        ownTaskId: 'cobol-modernization',
        identity,
      });
      assert.equal(result.analyzed, false);
      assert.match(result.notAnalyzedReason ?? '', /carries no maka_artifact_kind/);
    });

    test('and a full label is searched', () => {
      const result = scanTrajectory({
        trajectory: trajectory(['ordinary work'], {
          [TRAJECTORY_ARTIFACT_KIND_KEY]: TRAJECTORY_ARTIFACT_KIND_FULL,
        }),
        ownTaskId: 'cobol-modernization',
        identity,
      });
      assert.equal(result.analyzed, true);
    });
  });

  // The labels are Python's; this side only reads them. If the exporter renames
  // one, an unlabelled Maka trajectory would be searched as ordinary ATIF and a
  // degraded export would be reported clean — so the spelling is pinned here
  // rather than re-derived at runtime.
  test('the completeness labels are spelled the way the exporter writes them', async () => {
    const agent = await readFile(join(HARBOR_DIR, 'maka_agent.py'), 'utf8');
    const exporter = await readFile(join(HARBOR_DIR, 'maka_trajectory.py'), 'utf8');
    // Where, not only what. This side reads the label off the trajectory root;
    // an exporter that moved it into a step would still match a bare spelling
    // check, and a degraded summary would then be searched as if it were whole
    // — which is the failure that cost an entire 89-cell run.
    assert.match(
      agent,
      new RegExp(`extra=\\{\\s*"${TRAJECTORY_ARTIFACT_KIND_KEY}":`),
      'the artifact-kind label is no longer written on the trajectory root',
    );
    assert.match(exporter, new RegExp(`"${TRAJECTORY_SUMMARY_REASON_KEY}"`));
    assert.match(exporter, new RegExp(`artifact_kind="${TRAJECTORY_ARTIFACT_KIND_FULL}"`));
    assert.match(exporter, new RegExp(`artifact_kind="${TRAJECTORY_ARTIFACT_KIND_SUMMARY}"`));
  });
});

describe('scanRunForContamination', () => {
  async function withRun<T>(
    cells: Array<{ agent: string; taskId: string; trajectory?: unknown }>,
    fn: (runRoot: string) => Promise<T>,
  ): Promise<T> {
    const runRoot = await mkdtemp(join(tmpdir(), 'maka-contamination-run-'));
    try {
      for (const [index, cell] of cells.entries()) {
        const trialDir = join(runRoot, 'jobs', `${cell.agent}-r0-${index}`, 'trial');
        await mkdir(join(trialDir, 'agent'), { recursive: true });
        if (cell.trajectory !== undefined) {
          await writeFile(
            join(trialDir, 'agent', 'trajectory.json'),
            JSON.stringify(cell.trajectory),
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
      return await fn(runRoot);
    } finally {
      await rm(runRoot, { recursive: true, force: true });
    }
  }

  test('reads the run the harness wrote down, one trajectory per row', async () => {
    await withRun(
      [
        { agent: 'maka', taskId: 'cobol-modernization', trajectory: trajectory(['ordinary work']) },
        {
          agent: 'codex',
          taskId: 'fix-git',
          trajectory: trajectory(['git clone git@github.com:example-org/example-bench-2-1']),
        },
      ],
      async (runRoot) => {
        const report = await scanRunForContamination({
          trialCellLogPath: trialCellLogPath(runRoot),
          identity,
        });
        assert.deepEqual(report.totals, {
          cells: 2,
          analyzed: 2,
          cellsWithRetrievalSignals: 1,
          cellsWithAdvisorySignalsOnly: 0,
        });
        assert.deepEqual(report.coverageByAgent, {
          maka: { cells: 1, analyzed: 1 },
          codex: { cells: 1, analyzed: 1 },
        });
        assert.equal(report.cells[1]?.agent, 'codex');
        assert.match(report.cells[1]?.trajectoryPath ?? '', /agent\/trajectory\.json$/);
      },
    );
  });

  // The failure mode that looks most like success: an arm whose export never
  // landed reports no signals, and no signals reads as clean.
  test('counts a cell with no trajectory as unsearched, not as clean', async () => {
    await withRun(
      [
        { agent: 'maka', taskId: 'cobol-modernization' },
        { agent: 'codex', taskId: 'fix-git', trajectory: trajectory(['ordinary work']) },
      ],
      async (runRoot) => {
        const report = await scanRunForContamination({
          trialCellLogPath: trialCellLogPath(runRoot),
          identity,
        });
        assert.equal(report.totals.analyzed, 1);
        assert.equal(report.coverageByAgent.maka?.analyzed, 0);
        assert.match(report.cells[0]?.notAnalyzedReason ?? '', /unreadable/);
      },
    );
  });

  test('counts a task-id mention on its own as advisory', async () => {
    await withRun(
      [
        {
          agent: 'maka',
          taskId: 'cobol-modernization',
          trajectory: trajectory(['this suite also contains fix-git, I recall']),
        },
      ],
      async (runRoot) => {
        const report = await scanRunForContamination({
          trialCellLogPath: trialCellLogPath(runRoot),
          identity,
        });
        assert.equal(report.totals.cellsWithRetrievalSignals, 0);
        assert.equal(report.totals.cellsWithAdvisorySignalsOnly, 1);
      },
    );
  });

  // The retry deleted the first attempt's directory, so the superseded row now
  // points at the retry's artifacts. Counting it would report one cell twice,
  // and — in the other direction — would let an attempt the harness threw away
  // fail a run whose graded cell was clean.
  test('counts a retried cell once, as the attempt that is on disk', async () => {
    const runRoot = await mkdtemp(join(tmpdir(), 'maka-contamination-retry-'));
    try {
      const firstDir = join(runRoot, 'jobs', 'first', 'trial');
      const retryDir = join(runRoot, 'jobs', 'retry', 'trial');
      await mkdir(join(retryDir, 'agent'), { recursive: true });
      await writeFile(
        join(retryDir, 'agent', 'trajectory.json'),
        JSON.stringify(trajectory(['ordinary work'])),
        'utf8',
      );
      const row = {
        runId: 'run-1',
        roundId: 'maka-r0-cobol',
        taskId: 'cobol-modernization',
        agent: 'maka',
      };
      await appendTrialCell(trialCellLogPath(runRoot), { ...row, trialDir: firstDir });
      await appendTrialCell(trialCellLogPath(runRoot), { ...row, trialDir: retryDir });

      const report = await scanRunForContamination({
        trialCellLogPath: trialCellLogPath(runRoot),
        identity,
      });
      assert.deepEqual(report.totals, {
        cells: 1,
        analyzed: 1,
        cellsWithRetrievalSignals: 0,
        cellsWithAdvisorySignalsOnly: 0,
      });
      assert.equal(report.cells[0]?.trialDir, retryDir);
    } finally {
      await rm(runRoot, { recursive: true, force: true });
    }
  });

  // The run declares its grid; the log records what happened. A cell in the
  // first and not the second is a hole the report must name — a run killed at
  // cell three would otherwise certify the three that reached disk.
  test('names the cells the run scheduled and never recorded', async () => {
    await withRun(
      [{ agent: 'maka', taskId: 'cobol-modernization', trajectory: trajectory(['ordinary work']) }],
      async (runRoot) => {
        const report = await scanRunForContamination({
          trialCellLogPath: trialCellLogPath(runRoot),
          identity,
          expectedCells: [
            { agent: 'maka', taskId: 'cobol-modernization' },
            { agent: 'maka', taskId: 'fix-git' },
            { agent: 'codex', taskId: 'cobol-modernization' },
          ],
        });
        assert.deepEqual(report.unrecordedCells, [
          { agent: 'maka', taskId: 'fix-git' },
          { agent: 'codex', taskId: 'cobol-modernization' },
        ]);
      },
    );
  });
});
