import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { npmSpawnOptions } from './npm-spawn.mjs';
import { validateCliReleaseArtifactMetrics } from './release-cli-artifact-policy.mjs';
import {
  isMakaDevelopmentArtifact,
  isThirdPartyDevelopmentArtifact,
} from './release-cli-file-policy.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const cliSource = join(repoRoot, 'packages/cli');
const releaseRoot = join(cliSource, 'release');
const stageRoot = join(releaseRoot, 'package');
const allowDirty = process.argv.includes('--allow-dirty');
const preparedTree = process.env.MAKA_CLI_RELEASE_PREPARED_TREE === '1';
const unsupportedArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== '--allow-dirty');
if (unsupportedArguments.length > 0) {
  throw new Error(`Unsupported release argument: ${unsupportedArguments.join(', ')}`);
}
const internalPackageNames = [
  '@maka/code-mode',
  '@maka/core',
  '@maka/eval',
  '@maka/mcp',
  '@maka/runtime',
  '@maka/runtime-host',
  '@maka/storage',
];
const internalPackageSet = new Set(internalPackageNames);
const buildOrder = [
  '@maka/code-mode',
  '@maka/core',
  '@maka/storage',
  '@maka/mcp',
  '@maka/runtime',
  '@maka/runtime-host',
  '@maka/eval',
  'maka-agent',
];
const evalAssets = [
  'harbor/deepseek-codex-models.json',
  'harbor/deepseek-harness-profile/cordis.patch.yml',
  'harbor/deepseek-harness-profile/cordis.yml',
  'harbor/deepseek-harness-profile/package.json',
  'harbor/docker-compose-egress-proxy.yaml',
  'harbor/egress-proxy/Dockerfile',
  'harbor/egress-proxy/entrypoint.sh',
  'harbor/egress-proxy/network-policy',
  'harbor/egress_filter.py',
  'harbor/eval_framework.py',
  'harbor/relay_agent.py',
  'harbor/run_trial.py',
];
const strippedInstallScripts = new Map([
  // The clean repository install has already produced every generated file and
  // platform prebuild copied below. Do not run advisory postinstalls on an end
  // user's machine.
  ['node-pty@1.2.0-beta.15', new Set(['install', 'postinstall'])],
  ['protobufjs@7.6.5', new Set(['postinstall'])],
]);

main();

function main() {
  validateToolchain();
  if (!preparedTree && !allowDirty) {
    validateCleanWorktree();
    buildFromCleanDependencyTree();
    return;
  }
  if (preparedTree && allowDirty) {
    throw new Error('--allow-dirty cannot be combined with a prepared release tree');
  }
  if (preparedTree && existsSync(join(repoRoot, '.git'))) {
    throw new Error('A prepared release build must run inside the isolated source archive');
  }
  if (allowDirty) {
    console.warn(
      '[release-cli] WARNING: producing a private development tarball with publishing disabled',
    );
  }
  buildRuntimeWorkspaces();
  checkProductionAudit();
  runNpm(['run', 'check:cli-third-party-notices']);

  const dependencyTree = readCliDependencyTree();
  const cli = dependencyTree.dependencies?.['maka-agent'];
  if (!cli) throw new Error('npm ls did not return the maka-agent workspace');

  rmSync(releaseRoot, { recursive: true, force: true });
  mkdirSync(stageRoot, { recursive: true, mode: 0o755 });
  copyCliRuntime();
  const expectedDependencyManifests = copyDependencyClosure(cli);
  copyEvalMirror();
  copyReleaseDocuments();
  writeReleaseManifest(cli, preparedTree);
  validateStaging();

  const [pack] = JSON.parse(
    runNpm(['pack', stageRoot, '--json', '--pack-destination', releaseRoot], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  if (!pack?.filename || !Array.isArray(pack.files)) {
    throw new Error('npm pack did not return one JSON package result');
  }
  validateCliReleaseArtifactMetrics({
    compressedBytes: pack.size,
    unpackedBytes: pack.unpackedSize,
    entryCount: pack.entryCount,
  });
  const tarballPath = join(releaseRoot, pack.filename);
  validatePackedFiles(pack.files, expectedDependencyManifests);
  const sha256 = digestFile(tarballPath);
  writeFileSync(`${tarballPath}.sha256`, `${sha256}  ${pack.filename}\n`, 'utf8');
  writeFileSync(
    join(releaseRoot, `${pack.filename}.files.json`),
    `${JSON.stringify(pack.files, null, 2)}\n`,
    'utf8',
  );

  console.log(`[release-cli] tarball: ${tarballPath}`);
  console.log(`[release-cli] sha256: ${sha256}`);
  console.log(
    `[release-cli] size: ${formatBytes(pack.size)} compressed, ${formatBytes(pack.unpackedSize)} unpacked, ${pack.entryCount} files`,
  );
}

function buildFromCleanDependencyTree() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'maka-cli-release-build-'));
  const archivePath = join(temporaryRoot, 'source.tar');
  const cleanRoot = join(temporaryRoot, 'source');
  try {
    mkdirSync(cleanRoot, { recursive: true, mode: 0o755 });
    execFileSync('git', ['archive', '--format=tar', `--output=${archivePath}`, 'HEAD'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    execFileSync('tar', ['-xf', archivePath, '-C', cleanRoot], { stdio: 'inherit' });
    console.log('[release-cli] installing the committed dependency tree with npm ci');
    execFileSync('npm', ['ci'], npmSpawnOptions({ cwd: cleanRoot, stdio: 'inherit' }));
    execFileSync(process.execPath, [join(cleanRoot, 'scripts/release-cli-package.mjs')], {
      cwd: cleanRoot,
      env: { ...process.env, MAKA_CLI_RELEASE_PREPARED_TREE: '1' },
      stdio: 'inherit',
    });

    const cleanReleaseRoot = join(cleanRoot, 'packages/cli/release');
    if (!existsSync(cleanReleaseRoot)) {
      throw new Error('The isolated release build did not produce a release directory');
    }
    rmSync(releaseRoot, { recursive: true, force: true });
    cpSync(cleanReleaseRoot, releaseRoot, { recursive: true, preserveTimestamps: true });
    console.log(`[release-cli] copied the isolated release artifacts to ${releaseRoot}`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function validateToolchain() {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(`Node.js >=22.19.0 is required; found ${process.versions.node}`);
  }
  const packageManager = readJson(join(repoRoot, 'package.json')).packageManager;
  const requiredNpmVersion = /^npm@(.+)$/.exec(packageManager)?.[1];
  if (!requiredNpmVersion) {
    throw new Error(
      `The root packageManager must pin an exact npm version; found ${packageManager}`,
    );
  }
  const npmVersion = runNpm(['--version'], { encoding: 'utf8' }).trim();
  if (npmVersion !== requiredNpmVersion) {
    throw new Error(`npm ${requiredNpmVersion} is required; found ${npmVersion}`);
  }
}

function validateCleanWorktree() {
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  if (status) {
    throw new Error('Refusing to build a release tarball from a dirty worktree; commit first');
  }
}

function buildRuntimeWorkspaces() {
  for (const workspace of buildOrder) runNpm(['--workspace', workspace, 'run', 'clean']);
  for (const workspace of buildOrder) runNpm(['--workspace', workspace, 'run', 'build']);
}

function checkProductionAudit() {
  const audit = spawnSync(
    'npm',
    ['audit', '--omit=dev', '--workspace', 'maka-agent', '--json'],
    npmSpawnOptions({ cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
  );
  const report = JSON.parse(audit.stdout || '{}');
  const vulnerabilities = report.metadata?.vulnerabilities;
  if (audit.error || audit.status !== 0 || vulnerabilities?.total !== 0) {
    throw new Error(
      `CLI production dependency audit failed: ${JSON.stringify(vulnerabilities ?? report.error ?? audit.error)}`,
    );
  }
}

function readCliDependencyTree() {
  return JSON.parse(
    runNpm(['ls', '--workspace', 'maka-agent', '--omit=dev', '--all', '--long', '--json'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
}

function copyCliRuntime() {
  copyRuntimeDist(cliSource, stageRoot, { excludeDevCli: true });
  chmodSync(join(stageRoot, 'dist/cli.js'), 0o755);
}

function copyDependencyClosure(cli) {
  const copiedDestinations = new Map();
  const visit = (node, parentDestination) => {
    for (const dependency of Object.values(node.dependencies ?? {})) {
      if (!dependency || typeof dependency !== 'object') continue;
      const peerPolicy = dependencyPeerPolicy(node, dependency.name);
      if (peerPolicy === 'optional') continue;
      if (typeof dependency.path === 'string' && existsSync(dependency.path)) {
        const destination = dependencyDestination(dependency);
        const source = realpathSync(dependency.path);
        const previous = copiedDestinations.get(destination);
        if (previous && previous !== source) {
          throw new Error(
            `Dependency destination collision at ${destination}: ${previous} vs ${source}`,
          );
        }
        if (!previous) {
          if (internalPackageSet.has(dependency.name)) {
            copyInternalPackage(source, destination, dependency.name === '@maka/eval');
          } else {
            copyThirdPartyPackage(source, destination);
          }
          copiedDestinations.set(destination, source);
        }
        if (
          peerPolicy === 'required' &&
          parentDestination &&
          destination === join(parentDestination, 'node_modules', ...dependency.name.split('/'))
        ) {
          addBundledDependency(parentDestination, dependency.name, dependency.version);
        }
        visit(dependency, destination);
      }
    }
  };
  visit(cli, stageRoot);

  const evalUndici = findDependency(cli, 'undici', '8.10.0');
  if (!evalUndici?.path || !existsSync(evalUndici.path)) {
    throw new Error('The installed CLI closure does not contain undici@8.10.0');
  }
  copyThirdPartyPackage(realpathSync(evalUndici.path), join(stageRoot, 'node_modules/undici'));
  copiedDestinations.set(join(stageRoot, 'node_modules/undici'), realpathSync(evalUndici.path));
  return [...copiedDestinations.keys()].map(
    (destination) => `${relative(stageRoot, destination).split(sep).join('/')}/package.json`,
  );
}

function dependencyPeerPolicy(parent, dependencyName) {
  if (!dependencyName || typeof parent.path !== 'string' || !existsSync(parent.path)) return 'none';
  const manifest = readJson(join(realpathSync(parent.path), 'package.json'));
  if (!manifest.peerDependencies?.[dependencyName]) return 'none';
  return manifest.peerDependenciesMeta?.[dependencyName]?.optional ? 'optional' : 'required';
}

function addBundledDependency(packageRoot, dependencyName, dependencyVersion) {
  const manifestPath = join(packageRoot, 'package.json');
  const manifest = readJson(manifestPath);
  manifest.dependencies = { ...manifest.dependencies, [dependencyName]: dependencyVersion };
  manifest.bundledDependencies = [
    ...new Set([...(manifest.bundledDependencies ?? []), dependencyName]),
  ].sort();
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function dependencyDestination(dependency) {
  if (internalPackageSet.has(dependency.name)) {
    return join(stageRoot, 'node_modules', ...dependency.name.split('/'));
  }
  if (dependency.name?.startsWith('@maka/')) {
    throw new Error(`Unexpected private workspace in the CLI closure: ${dependency.name}`);
  }
  const sourcePath = resolve(dependency.path);
  const rootModules = join(repoRoot, 'node_modules');
  if (isInside(rootModules, sourcePath)) {
    return join(stageRoot, 'node_modules', relative(rootModules, sourcePath));
  }
  for (const packageName of internalPackageNames) {
    const workspaceRoot = realpathSync(join(repoRoot, 'node_modules', ...packageName.split('/')));
    const workspaceModules = join(workspaceRoot, 'node_modules');
    if (isInside(workspaceModules, sourcePath)) {
      return join(
        stageRoot,
        'node_modules',
        ...packageName.split('/'),
        'node_modules',
        relative(workspaceModules, sourcePath),
      );
    }
  }
  throw new Error(`Dependency path is outside the supported installed tree: ${sourcePath}`);
}

function copyInternalPackage(source, destination, includeEvalAssets) {
  mkdirSync(destination, { recursive: true, mode: 0o755 });
  const manifest = readJson(join(source, 'package.json'));
  const allowedFields = [
    'name',
    'version',
    'description',
    'license',
    'type',
    'sideEffects',
    'main',
    'exports',
    'bin',
    'engines',
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'peerDependenciesMeta',
  ];
  const releaseManifest = Object.fromEntries(
    allowedFields
      .filter((field) => manifest[field] !== undefined)
      .map((field) => [field, manifest[field]]),
  );
  writeFileSync(join(destination, 'package.json'), `${JSON.stringify(releaseManifest, null, 2)}\n`);
  copyRuntimeDist(source, destination);
  if (includeEvalAssets) {
    for (const asset of evalAssets) copyDeclaredFile(source, destination, asset);
  }
}

function copyRuntimeDist(source, destination, options = {}) {
  const sourceDist = join(source, 'dist');
  if (!existsSync(sourceDist)) throw new Error(`Missing build output: ${sourceDist}`);
  copyTreeFiles(sourceDist, join(destination, 'dist'), (relativePath) => {
    const segments = relativePath.split(sep);
    const file = segments.at(-1) ?? '';
    if (segments.some((segment) => segment === '__tests__' || segment === '__fixtures__')) {
      return false;
    }
    if (/(?:^|\.)test\.js$/.test(file) || file.endsWith('.d.ts') || file.endsWith('.map')) {
      return false;
    }
    if (options.excludeDevCli && file === 'dev-cli.js') return false;
    return file.endsWith('.js') || file.endsWith('.json');
  });
}

function copyThirdPartyPackage(source, destination) {
  if (!existsSync(join(source, 'package.json'))) {
    throw new Error(`Installed dependency has no package.json: ${source}`);
  }
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, {
    recursive: true,
    preserveTimestamps: true,
    filter: (path) => {
      if (path === source) return true;
      const relativePath = relative(source, path);
      return (
        !relativePath.split(sep).includes('node_modules') &&
        !isThirdPartyDevelopmentArtifact(relativePath)
      );
    },
  });
  stripReviewedInstallScripts(destination);
}

function stripReviewedInstallScripts(destination) {
  const manifestPath = join(destination, 'package.json');
  const manifest = readJson(manifestPath);
  const packageKey = `${manifest.name}@${manifest.version}`;
  const reviewed = strippedInstallScripts.get(packageKey);
  const present = ['preinstall', 'install', 'postinstall'].filter(
    (name) => typeof manifest.scripts?.[name] === 'string',
  );
  if (present.length === 0) return;
  if (!reviewed || present.some((name) => !reviewed.has(name))) {
    throw new Error(`${packageKey} has an unreviewed install script: ${present.join(', ')}`);
  }
  for (const name of present) delete manifest.scripts[name];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (packageKey === 'node-pty@1.2.0-beta.15') pruneNodePtyBuildInputs(destination);
}

function pruneNodePtyBuildInputs(destination) {
  // Without an explicit install script npm treats binding.gyp as a request to
  // run node-gyp. This release supports the platforms validated below through
  // shipped prebuilds, so source compilation would only add network/toolchain
  // dependence and bypass the reviewed artifact.
  for (const path of ['binding.gyp', 'scripts', 'src', 'third_party', 'typings']) {
    rmSync(join(destination, path), { recursive: true, force: true });
  }
  for (const path of walkFiles(destination)) {
    if (lstatSync(path).isFile() && /\.(?:map|pdb)$/.test(path)) rmSync(path, { force: true });
  }
}

function copyEvalMirror() {
  const stagedEval = join(stageRoot, 'node_modules/@maka/eval');
  const mirror = join(stageRoot, 'packages/eval');
  cpSync(stagedEval, mirror, {
    recursive: true,
    preserveTimestamps: true,
    filter: (path) =>
      path === stagedEval || !relative(stagedEval, path).split(sep).includes('node_modules'),
  });
}

function copyReleaseDocuments() {
  copyFileSync(join(cliSource, 'README.md'), join(stageRoot, 'README.md'));
  copyFileSync(join(cliSource, 'README.zh-CN.md'), join(stageRoot, 'README.zh-CN.md'));
  copyFileSync(join(repoRoot, 'LICENSE'), join(stageRoot, 'LICENSE'));
  copyFileSync(join(repoRoot, 'NOTICE'), join(stageRoot, 'NOTICE'));
  copyFileSync(
    join(cliSource, 'THIRD_PARTY_NOTICES.txt'),
    join(stageRoot, 'THIRD_PARTY_NOTICES.txt'),
  );
}

function writeReleaseManifest(cli, publishable) {
  const source = readJson(join(cliSource, 'package.json'));
  const root = readJson(join(repoRoot, 'package.json'));
  if (source.version !== cli.version) {
    throw new Error(
      `CLI manifest and installed lockfile disagree: ${source.version} vs ${cli.version}`,
    );
  }
  const undici = findDependency(cli, 'undici', '8.10.0');
  const dependencies = { ...source.dependencies, undici: undici.version };
  const manifest = {
    name: source.name,
    version: source.version,
    description: 'Local-first agent workspace for the terminal.',
    license: source.license,
    type: source.type,
    exports: {},
    bin: source.bin,
    engines: root.engines,
    repository: {
      type: 'git',
      url: 'git+https://github.com/maka-agent/maka-agent.git',
      directory: 'packages/cli',
    },
    homepage: 'https://github.com/maka-agent/maka-agent#readme',
    bugs: { url: 'https://github.com/maka-agent/maka-agent/issues' },
    keywords: ['ai', 'agent', 'cli', 'tui', 'local-first'],
    publishConfig: publishable
      ? {
          access: 'public',
          registry: 'https://registry.npmjs.org/',
          tag: source.version.includes('-') ? 'next' : 'latest',
        }
      : {
          access: 'restricted',
          registry: 'http://127.0.0.1:9/',
          tag: 'development',
        },
    files: [
      'dist',
      'packages/eval',
      'README.md',
      'README.zh-CN.md',
      'LICENSE',
      'NOTICE',
      'THIRD_PARTY_NOTICES.txt',
    ],
    dependencies,
    bundledDependencies: Object.keys(dependencies).sort(),
    ...(!publishable ? { private: true } : {}),
  };
  writeFileSync(join(stageRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function validateStaging() {
  const required = [
    'dist/cli.js',
    'README.zh-CN.md',
    'node_modules/@maka/runtime/dist/workers/filesystem-worker.js',
    'node_modules/@maka/runtime-host/dist/execution-candidate-main.js',
    'packages/eval/dist/harbor-external-subject.js',
    'packages/eval/harbor/relay_agent.py',
    'packages/eval/harbor/docker-compose-egress-proxy.yaml',
    'node_modules/node-pty/prebuilds/linux-x64/pty.node',
    'node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
    'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
    'node_modules/fs-native-extensions/prebuilds/linux-x64/fs-native-extensions.node',
    'node_modules/fs-native-extensions/prebuilds/darwin-arm64/fs-native-extensions.node',
    'node_modules/fs-native-extensions/prebuilds/win32-x64/fs-native-extensions.node',
  ];
  for (const path of required) {
    if (!existsSync(join(stageRoot, path)))
      throw new Error(`Required release file is missing: ${path}`);
  }
  assertPatchedFile(
    'node_modules/node-pty/lib/unixTerminal.js',
    'CustomWriteStream.prototype._ownsFileDescriptor',
  );
  assertPatchedFile('node_modules/@ai-sdk/provider-utils/dist/index.js', 'function absentIfBlank');

  const manifest = readJson(join(stageRoot, 'package.json'));
  for (const [name, specifier] of Object.entries(manifest.dependencies ?? {})) {
    if (
      typeof specifier !== 'string' ||
      /^(?:file:|workspace:)|^[A-Za-z]:[\\/]|^\//.test(specifier)
    ) {
      throw new Error(`Release dependency must use a registry version: ${name}@${specifier}`);
    }
    if (
      name.startsWith('@maka/') &&
      !existsSync(join(stageRoot, 'node_modules', ...name.split('/')))
    ) {
      throw new Error(`Private dependency is not physically bundled: ${name}`);
    }
  }

  for (const path of walkFiles(stageRoot)) {
    const relativePath = relative(stageRoot, path);
    const status = lstatSync(path);
    if (status.isSymbolicLink())
      throw new Error(`Release staging contains a symlink: ${relativePath}`);
    if (!status.isFile()) continue;
    if (basename(path) === 'package.json') {
      const packageManifest = readJson(path);
      const installScript = ['preinstall', 'install', 'postinstall'].find(
        (name) => typeof packageManifest.scripts?.[name] === 'string',
      );
      if (installScript) {
        throw new Error(
          `Release dependency retains an install script: ${relativePath} (${installScript})`,
        );
      }
    }
    const content = readFileSync(path);
    if (content.includes(Buffer.from(repoRoot))) {
      throw new Error(`Release file contains the repository path: ${relativePath}`);
    }
  }
}

function validatePackedFiles(files, expectedDependencyManifests) {
  const paths = files.map((file) => file.path);
  for (const file of files) {
    const { path } = file;
    if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
      throw new Error(`Unsafe tarball path: ${path}`);
    }
    const segments = path.split('/');
    const makaOwned =
      path.startsWith('dist/') ||
      path.startsWith('packages/eval/') ||
      (segments[0] === 'node_modules' && segments[1] === '@maka' && segments[3] !== 'node_modules');
    if (makaOwned && isMakaDevelopmentArtifact(path)) {
      throw new Error(`Development artifact escaped into the tarball: ${path}`);
    }
    if (!makaOwned && path.startsWith('node_modules/') && isThirdPartyDevelopmentArtifact(path)) {
      throw new Error(`Third-party development artifact escaped into the tarball: ${path}`);
    }
    const fileName = basename(path).toLowerCase();
    if (
      /^\.env(?:\..*)?$/.test(fileName) ||
      fileName === 'deepseek.key' ||
      /\.(?:key|p12|pfx|pem)$/.test(fileName) ||
      fileName === 'id_rsa' ||
      fileName === 'id_ed25519'
    ) {
      throw new Error(`Credential-like file escaped into the tarball: ${path}`);
    }
  }
  const requiredPacked = [
    'dist/cli.js',
    'node_modules/@maka/runtime/dist/workers/filesystem-worker.js',
    'node_modules/@maka/runtime-host/dist/execution-candidate-main.js',
    'packages/eval/harbor/relay_agent.py',
  ];
  for (const suffix of requiredPacked) {
    if (!paths.some((path) => path.endsWith(suffix))) {
      throw new Error(`Required file was not packed: ${suffix}`);
    }
  }
  for (const manifestPath of expectedDependencyManifests) {
    if (!paths.includes(manifestPath)) {
      throw new Error(`Production dependency was not packed: ${manifestPath}`);
    }
  }
  const bin = files.find((file) => file.path === 'dist/cli.js');
  if (!bin || (bin.mode & 0o111) === 0) {
    throw new Error('The packed CLI entrypoint is not executable');
  }
}

function assertPatchedFile(path, marker) {
  const content = readFileSync(join(stageRoot, path), 'utf8');
  if (!content.includes(marker)) throw new Error(`Patched dependency marker is missing: ${path}`);
  console.log(`[release-cli] patch: ${path} sha256=${digestFile(join(stageRoot, path))}`);
}

function findDependency(root, name, version) {
  let result;
  const visit = (node) => {
    for (const dependency of Object.values(node.dependencies ?? {})) {
      if (!dependency || typeof dependency !== 'object') continue;
      if (dependency.name === name && dependency.version === version) result ??= dependency;
      visit(dependency);
    }
  };
  visit(root);
  return result;
}

function copyDeclaredFile(source, destination, relativePath) {
  const from = join(source, relativePath);
  if (!existsSync(from) || !statSync(from).isFile()) {
    throw new Error(`Declared Eval runtime asset is missing: ${from}`);
  }
  const to = join(destination, relativePath);
  mkdirSync(dirname(to), { recursive: true, mode: 0o755 });
  copyFileSync(from, to);
}

function copyTreeFiles(source, destination, allow) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const path = join(source, entry.name);
    const relativePath = relative(source, path);
    if (entry.isDirectory()) {
      copyTreeFiles(path, join(destination, entry.name), (nestedPath) =>
        allow(join(entry.name, nestedPath)),
      );
    } else if (entry.isFile() && allow(relativePath)) {
      mkdirSync(destination, { recursive: true, mode: 0o755 });
      copyFileSync(path, join(destination, entry.name));
    } else if (entry.isSymbolicLink()) {
      throw new Error(`Maka build output contains an unexpected symlink: ${path}`);
    }
  }
}

function walkFiles(root) {
  const paths = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    paths.push(path);
    if (entry.isDirectory()) paths.push(...walkFiles(path));
  }
  return paths;
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path !== '' && !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runNpm(args, options = {}) {
  return execFileSync(
    'npm',
    args,
    npmSpawnOptions({ cwd: repoRoot, stdio: options.encoding ? undefined : 'inherit', ...options }),
  );
}

function digestFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
