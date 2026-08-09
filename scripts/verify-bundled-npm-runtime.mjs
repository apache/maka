import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { create as createTar } from 'tar';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export async function verifyPreparedBundledNpm({
  resourcesRoot = join(repoRoot, 'apps', 'desktop', '.generated', 'bundled-npm'),
} = {}) {
  const { resolveBundledNpmRuntime } = await import(
    new URL('../packages/runtime-host/dist/server/bundled-npm-runtime.js', import.meta.url)
  );
  const { runManagedDependencyProducerProcessInternal, runManagedNpmDependencyProvision } =
    await import(
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
    await verifyRealDependencyInstall({
      capability,
      scratchProject: join(scratchProject, 'real-install'),
      runManagedDependencyProducerProcessInternal,
    });
  } finally {
    await rm(scratchProject, { recursive: true, force: true });
  }
  return capability;
}

async function verifyRealDependencyInstall({
  capability,
  scratchProject,
  runManagedDependencyProducerProcessInternal,
}) {
  const fixtureRoot = join(scratchProject, 'registry-fixture');
  const packageRoot = join(fixtureRoot, 'package');
  const tarballPath = join(fixtureRoot, 'maka-fixture-bin-1.0.0.tgz');
  const projectRoot = join(scratchProject, 'project');
  const outputRoot = join(projectRoot, 'node_modules');
  const scratchRoot = join(projectRoot, '.maka-runtime');
  const homeRoot = join(scratchRoot, 'home');
  const cacheRoot = join(scratchRoot, 'cache');
  const tempRoot = join(scratchRoot, 'temp');
  await Promise.all([
    mkdir(join(packageRoot, 'bin'), { recursive: true }),
    mkdir(outputRoot, { recursive: true }),
    mkdir(homeRoot, { recursive: true }),
    mkdir(cacheRoot, { recursive: true }),
    mkdir(tempRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(packageRoot, 'package.json'),
      `${JSON.stringify({
        name: 'maka-fixture-bin',
        version: '1.0.0',
        bin: { 'maka-fixture': 'bin/cli.js' },
      })}\n`,
    ),
    writeFile(join(packageRoot, 'index.js'), 'export const installed = true;\n'),
    writeFile(join(packageRoot, 'bin', 'cli.js'), '#!/usr/bin/env node\nconsole.log("fixture");\n'),
  ]);
  if (process.platform !== 'win32') await chmod(join(packageRoot, 'bin', 'cli.js'), 0o755);
  await createTar({ cwd: fixtureRoot, file: tarballPath, gzip: true }, ['package']);
  const tarball = await readFile(tarballPath);
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  const registry = await startFixtureRegistry(tarball, integrity);
  try {
    const manifest = {
      name: 'maka-bundled-npm-real-smoke',
      private: true,
      packageManager: 'npm@12.0.2',
      dependencies: { 'maka-fixture-bin': '1.0.0' },
    };
    const resolved = `${registry.origin}maka-fixture-bin/-/maka-fixture-bin-1.0.0.tgz`;
    const lockfile = {
      name: manifest.name,
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: manifest.name, dependencies: manifest.dependencies },
        'node_modules/maka-fixture-bin': {
          version: '1.0.0',
          resolved,
          integrity,
          bin: { 'maka-fixture': 'bin/cli.js' },
        },
      },
    };
    const userConfig = join(homeRoot, 'npmrc');
    const globalConfig = join(homeRoot, 'global-npmrc');
    const config = `registry=${registry.origin}\n`;
    await Promise.all([
      writeFile(join(projectRoot, 'package.json'), `${JSON.stringify(manifest)}\n`),
      writeFile(join(projectRoot, 'package-lock.json'), `${JSON.stringify(lockfile)}\n`),
      writeFile(userConfig, config),
      writeFile(globalConfig, config),
    ]);
    await runManagedDependencyProducerProcessInternal({
      argv: [
        capability.nodeExecutablePath,
        '--permission',
        ...(Number.parseInt(capability.nodeVersion.split('.')[0] ?? '', 10) >= 26
          ? ['--allow-net']
          : []),
        `--allow-fs-read=${capability.npmRuntimeRoot}`,
        `--allow-fs-read=${projectRoot}`,
        `--allow-fs-write=${projectRoot}`,
        capability.npmCliPath,
        'ci',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--package-lock=true',
        `--registry=${registry.origin}`,
        `--cache=${cacheRoot}`,
        `--userconfig=${userConfig}`,
        `--globalconfig=${globalConfig}`,
      ],
      cwd: projectRoot,
      monitorRoot: projectRoot,
      env: {
        HOME: homeRoot,
        USERPROFILE: homeRoot,
        npm_config_registry: registry.origin,
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_ignore_scripts: 'true',
        npm_config_update_notifier: 'false',
        TEMP: tempRoot,
        TMP: tempRoot,
        TMPDIR: tempRoot,
        ...(process.platform === 'win32'
          ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }
          : {}),
      },
      timeoutMs: 60_000,
      maxObservedBytes: 64 * 1024 * 1024,
      maxObservedEntries: 10_000,
    });
    const installed = JSON.parse(
      await readFile(join(outputRoot, 'maka-fixture-bin', 'package.json'), 'utf8'),
    );
    if (installed.name !== 'maka-fixture-bin' || installed.version !== '1.0.0') {
      throw new Error('Bundled npm did not install the hermetic fixture package');
    }
    const binPath = join(
      outputRoot,
      '.bin',
      process.platform === 'win32' ? 'maka-fixture.cmd' : 'maka-fixture',
    );
    const binInfo = await lstat(binPath);
    if (process.platform === 'win32' ? !binInfo.isFile() : !binInfo.isSymbolicLink()) {
      throw new Error('Bundled npm did not create the expected platform .bin entry');
    }
  } finally {
    await registry.close();
  }
}

async function startFixtureRegistry(tarball, integrity) {
  let origin = '';
  const server = createServer((request, response) => {
    if (request.url === '/maka-fixture-bin') {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          name: 'maka-fixture-bin',
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              name: 'maka-fixture-bin',
              version: '1.0.0',
              bin: { 'maka-fixture': 'bin/cli.js' },
              dist: {
                integrity,
                tarball: `${origin}maka-fixture-bin/-/maka-fixture-bin-1.0.0.tgz`,
              },
            },
          },
        }),
      );
      return;
    }
    if (request.url === '/maka-fixture-bin/-/maka-fixture-bin-1.0.0.tgz') {
      response.setHeader('content-type', 'application/octet-stream');
      response.end(tarball);
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture registry did not bind TCP');
  origin = `http://127.0.0.1:${address.port}/`;
  return {
    origin,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
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
