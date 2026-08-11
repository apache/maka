import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(packageRoot, 'dist', 'workers', 'filesystem-worker.js');
const agentsCoreUtils = fileURLToPath(import.meta.resolve('@openai/agents-core/utils'));

await mkdir(dirname(outfile), { recursive: true });
await build({
  entryPoints: [resolve(packageRoot, 'src', 'filesystem-worker', 'worker-entry.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  alias: {
    '@openai/agents-core/utils': resolve(dirname(agentsCoreUtils), 'applyDiff.mjs'),
  },
  sourcemap: false,
  legalComments: 'none',
});
