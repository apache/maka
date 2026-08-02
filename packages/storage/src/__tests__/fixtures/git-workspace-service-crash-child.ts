import { writeFileSync, writeSync } from 'node:fs';
import { createGitWorkspaceService } from '../../git-workspace-service.js';

const service = createGitWorkspaceService({
  storageRoot: requiredEnv('MAKA_GIT_WORKSPACE_STORAGE'),
  gitRuntime: {
    executablePath: requiredEnv('MAKA_GIT_WORKSPACE_EXECUTABLE'),
    expectedSha256: requiredEnv('MAKA_GIT_WORKSPACE_SHA256') as `sha256:${string}`,
  },
  failpoint(point) {
    if (point !== requiredEnv('MAKA_GIT_WORKSPACE_FAILPOINT')) return;
    writeSync(1, 'READY\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  },
});

const binding = await service.createManagedWorkspaceFromSource({
  repositoryId: 'repository_11111111111111111111111111111111',
  workspaceId: 'workspace_22222222222222222222222222222222',
  workspaceEpochId: 'epoch_33333333333333333333333333333333',
  workspaceInstanceId: 'instance_44444444444444444444444444444444',
  sourceRoot: requiredEnv('MAKA_GIT_WORKSPACE_SOURCE'),
});

if (process.env.MAKA_GIT_WORKSPACE_ACTION === 'quarantine') {
  writeFileSync(
    requiredEnv('MAKA_GIT_WORKSPACE_BINDING_OUTPUT'),
    `${JSON.stringify(binding)}\n`,
    'utf8',
  );
  await service.quarantineManagedWorkspace(binding, 'crash_convergence_test');
}

throw new Error('Git workspace crash child missed its failpoint');

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
