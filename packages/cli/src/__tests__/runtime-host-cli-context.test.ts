import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { RuntimeHostConnection } from '@maka/runtime-host/client';
import { connectRuntimeHostCli } from '../runtime-host-cli-context.js';

test('CLI Runtime Host bootstrap launches the execution composition', async () => {
  let candidateEntrypoint: string | URL | undefined;
  let closes = 0;
  const connection = {
    status: async () => ({ state: 'ready' }),
    close: async () => {
      closes += 1;
    },
  } as unknown as RuntimeHostConnection;

  const context = await connectRuntimeHostCli(
    { rootPath: '/runtime-host-root', surface: 'run' },
    {
      connectOrSpawn: async (input) => {
        candidateEntrypoint = input.candidateEntrypoint;
        return { kind: 'connected', connection };
      },
      readConnectionCatalog: async () => ({
        revision: 1,
        defaultTarget: null,
        connections: [],
      }),
    },
  );

  assert.ok(candidateEntrypoint instanceof URL);
  assert.equal(basename(fileURLToPath(candidateEntrypoint)), 'execution-candidate-main.js');
  await context.close();
  assert.equal(closes, 1);
});
