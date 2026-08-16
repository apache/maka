import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Runs real filesystem-worker operations (write, read, glob, grep and a
 * denied outside write) through FilesystemWorkerClient against the PACKAGED
 * Windows sandbox broker — the AppContainer boundary, the ACL grants and the
 * stdio relay of the shipped binary, not just its self-probe.
 *
 * The worker bundle and client code come from the repository build (the
 * packaged copies live inside app.asar, which plain node cannot import); the
 * artifact under test is the packaged broker executable.
 */
export async function verifyWindowsSandboxWorkerE2E(sandboxExecutablePath) {
  const sandboxExecutable = resolve(sandboxExecutablePath);
  assertCondition(existsSync(sandboxExecutable), `Missing broker: ${sandboxExecutable}`);
  const runtimeDist = join(repoRoot, 'packages', 'runtime', 'dist');
  const importDist = (relativePath) => import(pathToFileURL(join(runtimeDist, relativePath)).href);
  const { FilesystemWorkerClient, FilesystemWorkerClientError } = await importDist(
    'filesystem-worker/client.js',
  );
  const { createFilesystemWorkerLaunchSpecProvider } = await importDist(
    'filesystem-worker/launch-spec.js',
  );
  const { SandboxManager } = await importDist('sandbox/sandbox-manager.js');
  const { WindowsBrokerSandboxBackend, createWindowsBrokerManifestWriter } = await importDist(
    'sandbox/windows-sandbox.js',
  );

  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'maka-packaged-e2e-ws-')));
  const outside = await realpath(await mkdtemp(join(homedir(), '.maka-packaged-e2e-outside-')));
  const runtimeBase = await realpath(await mkdtemp(join(tmpdir(), 'maka-packaged-e2e-rt-')));
  try {
    // Mirror an installed `%LOCALAPPDATA%\Programs\Maka` topology with an
    // unrelated sibling. The launch spec must never widen the recursive grant
    // to their shared `Programs` parent.
    const programsRoot = join(runtimeBase, 'Programs');
    const runtimeBin = join(programsRoot, 'Maka');
    await mkdir(runtimeBin, { recursive: true });
    await mkdir(join(programsRoot, 'UnrelatedApp'), { recursive: true });
    const nodeCopy = join(runtimeBin, 'node.exe');
    await copyFile(process.execPath, nodeCopy);
    const getLaunchSpec = createFilesystemWorkerLaunchSpecProvider({
      runtime: 'node',
      executable: nodeCopy,
      resourceLocation: { kind: 'runtime' },
    });
    const launchSpec = await getLaunchSpec();
    assertCondition(launchSpec.ok, 'Windows filesystem-worker launch spec was unavailable.');
    assertCondition(
      launchSpec.ok && launchSpec.spec.runtimeReadableRoots.includes(await realpath(runtimeBin)),
      'Windows launch spec omitted its product-owned application directory.',
    );
    assertCondition(
      launchSpec.ok && !launchSpec.spec.runtimeReadableRoots.includes(await realpath(programsRoot)),
      'Windows launch spec widened the runtime ACL root to the shared Programs directory.',
    );

    const client = new FilesystemWorkerClient({
      sandboxManager: new SandboxManager([
        new WindowsBrokerSandboxBackend({
          clientPath: sandboxExecutable,
          writeManifest: createWindowsBrokerManifestWriter(),
        }),
      ]),
      platform: 'win32',
      getLaunchSpec,
    });
    const execute = (operation) => client.execute({ operation, cwd: workspace, mode: 'ask' });

    const insidePath = join(workspace, 'inside.txt');
    await execute({ kind: 'write', path: insidePath, content: 'packaged-relay-ok' });
    assertCondition(
      (await readFile(insidePath, 'utf8')) === 'packaged-relay-ok',
      'Sandboxed write did not land in the workspace.',
    );

    const read = await execute({ kind: 'read', path: insidePath });
    assertCondition(
      read.kind === 'read' && read.content.includes('packaged-relay-ok'),
      'Sandboxed read did not return the written content.',
    );

    const sourceDirectory = join(workspace, 'src');
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(join(sourceDirectory, 'health.ts'), 'export const healthSignal = true;\n');
    const globResult = await execute({
      kind: 'glob',
      path: sourceDirectory,
      pattern: '**/*.ts',
    });
    assertCondition(
      globResult.kind === 'glob' && globResult.files.length === 1,
      'Sandboxed glob did not find the expected file.',
    );
    const grepResult = await execute({
      kind: 'grep',
      path: sourceDirectory,
      pattern: 'healthSignal',
      maxCountPerFile: 50,
      limit: 200,
      timeoutMs: 10_000,
    });
    assertCondition(
      grepResult.kind === 'grep' && grepResult.matches.length === 1,
      'Sandboxed grep did not find the expected match.',
    );

    let denied = false;
    try {
      await execute({ kind: 'write', path: join(outside, 'blocked.txt'), content: 'blocked' });
    } catch (error) {
      denied = error instanceof FilesystemWorkerClientError && error.reason === 'path_denied';
    }
    assertCondition(denied, 'Write outside the workspace was not denied.');
    assertCondition(
      !existsSync(join(outside, 'blocked.txt')),
      'Denied write still produced a file.',
    );
  } finally {
    for (const path of [workspace, outside, runtimeBase]) {
      await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const executable = process.argv[2];
  if (!executable) {
    throw new Error(
      'Usage: node scripts/verify-windows-sandbox-e2e.mjs <maka-windows-sandbox.exe>',
    );
  }
  await verifyWindowsSandboxWorkerE2E(executable);
  console.log('Packaged Windows filesystem-worker E2E verified.');
}
