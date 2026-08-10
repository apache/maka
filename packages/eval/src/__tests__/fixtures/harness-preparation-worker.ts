import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarborExecutor } from '../../harness-executor.js';

const root = await mkdtemp(join(tmpdir(), 'maka-eval-harness-preparation-'));
process.env.MAKA_TEST_PYTHON = join(root, 'missing-python');
process.env.MAKA_TEST_TRIALS = root;
const executor = createHarborExecutor(
  {
    frameworkVersion: '0.20.0',
    pythonPathEnv: 'MAKA_TEST_PYTHON',
    trialsRootEnv: 'MAKA_TEST_TRIALS',
    containerCwd: '/app',
    environment: {},
    mounts: [],
  },
  import.meta.url,
);

await executor
  .runAttempt(
    {
      cell: {
        id: 'task::1::subject',
        experimentId: 'experiment',
        benchmark: { id: 'benchmark', version: 'version', config: { repository: 'repo' } },
        executor: { kind: 'harbor', config: {} },
        subject: { id: 'subject', kind: 'external', credentials: [], config: {} },
        task: { id: 'task', input: 'solve', config: { harbor: { path: 'task' } } },
        repetition: 1,
        budget: { timeoutMultiplier: 1 },
        verifier: {},
      },
    },
    async () => {
      throw new Error('operation must not run');
    },
  )
  .catch(() => undefined);

process.stdout.write('SETTLED\n');
