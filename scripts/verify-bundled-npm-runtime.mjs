import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBundledNpmDependencyProducer } from '../packages/runtime-host/dist/server/bundled-npm-dependency-producer.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const resourcesRoot = join(repoRoot, 'apps', 'desktop', '.generated', 'bundled-npm');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'maka-bundled-npm-smoke-'));

try {
  const producer = await resolveBundledNpmDependencyProducer({
    resourcesRoot,
    nodeExecutablePath: process.execPath,
  });
  const projectRoot = join(temporaryRoot, 'project');
  const outputRoot = join(projectRoot, 'node_modules');
  const scratchRoot = join(projectRoot, '.maka-runtime');
  await Promise.all([
    mkdir(outputRoot, { recursive: true }),
    mkdir(scratchRoot, { recursive: true }),
  ]);
  const manifestBytes = Buffer.from(
    '{"name":"maka-bundled-npm-smoke","version":"1.0.0","packageManager":"npm@12.0.2"}\n',
  );
  const lockfileBytes = Buffer.from(
    '{"name":"maka-bundled-npm-smoke","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"maka-bundled-npm-smoke","version":"1.0.0"}}}\n',
  );
  await producer.provision({
    identity: {
      protocolVersion: 1,
      environmentId: `sha256:${'1'.repeat(64)}`,
      manifestPath: 'package.json',
      manifestSha256: `sha256:${'2'.repeat(64)}`,
      lockfilePath: 'package-lock.json',
      lockfileSha256: `sha256:${'3'.repeat(64)}`,
      packageManagerName: 'npm',
      packageManagerVersion: producer.packageManagerVersion,
      nodeVersion: producer.nodeRuntime.version,
      nodeAbi: producer.nodeRuntime.abi,
      platform: producer.nodeRuntime.platform,
      arch: producer.nodeRuntime.arch,
      policyVersion: 'managed_dependency_environment_v1',
    },
    outputRoot,
    scratchRoot,
    manifestBytes,
    lockfileBytes,
  });
  console.log(
    `[bundled-npm] verified npm ${producer.packageManagerVersion} with Node ${producer.nodeRuntime.version}`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
