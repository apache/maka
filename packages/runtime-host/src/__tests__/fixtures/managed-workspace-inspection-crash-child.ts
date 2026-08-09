import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { openManagedWorkspaceOwner } from '@maka/storage/managed-workspace-owner';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { resolveBundledNpmRuntime } from '../../server/bundled-npm-runtime.js';
import { createManagedNpmDependencyEnvironmentProducer } from '../../server/managed-npm-dependency-producer.js';
import { createManagedWorkspaceInspectionTool } from '../../server/managed-workspace-inspection-tool.js';
import { createRuntimeHostWorkspaceExecutionComposition } from '../../server/workspace-execution-composition.js';

const execFileAsync = promisify(execFile);
const storageRoot = process.env.MAKA_MANAGED_INSPECTION_CRASH_STORAGE_ROOT;
const sourceRoot = process.env.MAKA_MANAGED_INSPECTION_CRASH_SOURCE_ROOT;
const resourcesRoot = process.env.MAKA_MANAGED_INSPECTION_CRASH_RESOURCES_ROOT;
if (!storageRoot || !sourceRoot || !resourcesRoot) {
  throw new Error('Missing managed inspection crash fixture input');
}

const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
const rootOwner = await tryAcquireInteractiveRootOwner(capability);
if (!rootOwner) throw new Error('Managed inspection crash fixture did not acquire root ownership');
const stores = await openInteractiveExecutionStoresForWrite(rootOwner.lease);
const gitExecutable = await findGitExecutable();
const owner = await openManagedWorkspaceOwner({
  rootOwner,
  gitRuntime: {
    executablePath: gitExecutable,
    expectedSha256: await sha256File(gitExecutable),
  },
  dependencyEnvironmentProducer: createManagedNpmDependencyEnvironmentProducer(
    await resolveBundledNpmRuntime({ resourcesRoot }),
  ),
  filesystemWorker: {
    async execute(input) {
      if (input.operation.kind !== 'read') throw new Error('Crash fixture expected Read');
      return { kind: 'read', content: await readFile(input.operation.path, 'utf8') };
    },
  },
  failpoint(point) {
    if (String(point) === 'after_environment_receipt_durable') process.exit(73);
  },
});
const composition = createRuntimeHostWorkspaceExecutionComposition({
  managedOwner: owner,
  executionStores: stores,
});
const tool = createManagedWorkspaceInspectionTool(composition);
await tool.impl(
  { kind: 'read', path: 'node_modules/fixture-package/index.js' },
  {
    sessionId: 'session_11111111111111111111111111111111',
    turnId: 'turn_22222222222222222222222222222222',
    toolCallId: 'call_33333333333333333333333333333333',
    cwd: sourceRoot,
    abortSignal: new AbortController().signal,
    emitOutput() {},
  },
);
throw new Error('Managed inspection crash fixture missed its failpoint');

async function findGitExecutable(): Promise<string> {
  const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where.exe' : 'which', [
    'git',
  ]);
  const first = stdout
    .split(/\r?\n/u)
    .find((line) => line.trim())
    ?.trim();
  if (!first) throw new Error('Git executable is unavailable');
  return await realpath(first);
}

async function sha256File(path: string): Promise<`sha256:${string}`> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}
