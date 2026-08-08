import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export async function verifyPreparedBundledNpm({
  resourcesRoot = join(repoRoot, 'apps', 'desktop', '.generated', 'bundled-npm'),
} = {}) {
  const { resolveBundledNpmRuntime } = await import(
    new URL('../packages/runtime-host/dist/server/bundled-npm-runtime.js', import.meta.url)
  );
  const { runManagedNpmDependencyProvision } = await import(
    new URL(
      '../packages/runtime-host/dist/server/managed-dependency-producer-process.js',
      import.meta.url,
    )
  );
  const capability = await resolveBundledNpmRuntime({ resourcesRoot });
  if (capability.npmVersion !== '12.0.2') {
    throw new Error(`Expected bundled npm 12.0.2, found ${capability.npmVersion}.`);
  }
  const scratchProject = await mkdtemp(join(tmpdir(), 'maka-bundled-npm-smoke-'));
  try {
    const outputRoot = join(scratchProject, 'node_modules');
    const scratchRoot = join(scratchProject, '.maka-runtime');
    await Promise.all([
      mkdir(outputRoot, { recursive: true }),
      mkdir(scratchRoot, { recursive: true }),
    ]);
    const manifestBytes = Buffer.from(
      '{"name":"maka-bundled-npm-smoke","private":true,"packageManager":"npm@12.0.2"}\n',
    );
    const lockfileBytes = Buffer.from(
      '{"name":"maka-bundled-npm-smoke","lockfileVersion":3,"requires":true,"packages":{"":{"name":"maka-bundled-npm-smoke"}}}\n',
    );
    await runManagedNpmDependencyProvision({
      runtime: capability,
      producerInput: {
        identity: {
          protocolVersion: 1,
          environmentId: digest(Buffer.concat([manifestBytes, lockfileBytes])),
          manifestPath: 'package.json',
          manifestSha256: digest(manifestBytes),
          lockfilePath: 'package-lock.json',
          lockfileSha256: digest(lockfileBytes),
          packageManagerName: 'npm',
          packageManagerVersion: capability.npmVersion,
          nodeVersion: capability.nodeVersion,
          nodeAbi: capability.nodeAbi,
          platform: capability.platform,
          arch: capability.arch,
          producerRuntimeIdentitySha256: capability.runtimeIdentitySha256,
          producerPolicyIdentitySha256: digest(Buffer.from('hermetic_dependency_builder_v1')),
          policyVersion: 'managed_dependency_environment_v1',
        },
        outputRoot,
        scratchRoot,
        manifestBytes,
        lockfileBytes,
      },
    });
  } finally {
    await rm(scratchProject, { recursive: true, force: true });
  }
  return capability;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const capability = await verifyPreparedBundledNpm();
  console.log(
    `Verified bundled npm ${capability.npmVersion} for ${capability.platform}-${capability.arch}.`,
  );
}
