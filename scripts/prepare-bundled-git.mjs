import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const expectedDugiteVersion = '3.2.2';
const sha256Pattern = /^[a-f0-9]{64}$/u;

export async function prepareBundledGit({
  dugiteRoot = join(repoRoot, 'node_modules', 'dugite'),
  gitLicensePath = join(repoRoot, 'apps', 'desktop', 'resources', 'licenses', 'git', 'LICENSE.txt'),
  outputPath = join(repoRoot, 'apps', 'desktop', 'bundled-git.json'),
  platform = process.platform,
  arch = process.arch,
  runGit = runGitVersion,
} = {}) {
  const packageManifest = JSON.parse(await readFile(join(dugiteRoot, 'package.json'), 'utf8'));
  if (packageManifest.name !== 'dugite' || packageManifest.version !== expectedDugiteVersion) {
    throw new Error(`Bundled Git preparation requires dugite ${expectedDugiteVersion}.`);
  }
  await requireRegularFile(join(dugiteRoot, 'LICENSE'), 'dugite license');
  await requireRegularFile(gitLicensePath, 'packaged Git license');

  const embeddedGit = JSON.parse(
    await readFile(join(dugiteRoot, 'script', 'embedded-git.json'), 'utf8'),
  );
  const archive = embeddedGit[`${platform}-${arch}`];
  if (
    !archive ||
    typeof archive !== 'object' ||
    typeof archive.name !== 'string' ||
    typeof archive.url !== 'string' ||
    typeof archive.checksum !== 'string' ||
    !sha256Pattern.test(archive.checksum)
  ) {
    throw new Error(
      `dugite ${expectedDugiteVersion} does not provide a pinned Git archive for ${platform}-${arch}.`,
    );
  }
  const gitVersion = parseArchiveGitVersion(archive.name);
  const executableRelativePath = platform === 'win32' ? 'git/cmd/git.exe' : 'git/bin/git';
  const executablePath = resolve(dugiteRoot, ...executableRelativePath.split('/'));
  assertWithin(dugiteRoot, executablePath);
  await requireRegularFile(executablePath, 'bundled Git executable');

  const reportedVersion = await runGit(executablePath);
  if (
    !new RegExp(`^git version ${escapeRegExp(gitVersion)}(?:[.\\s]|$)`, 'u').test(
      reportedVersion.trim(),
    )
  ) {
    throw new Error(
      `Bundled Git executable reported ${JSON.stringify(reportedVersion.trim())}; expected Git ${gitVersion}.`,
    );
  }

  const manifest = {
    schemaVersion: 1,
    protocol: 'maka_bundled_git_runtime_v1',
    provider: 'desktop/dugite-native',
    gitVersion,
    platform,
    arch,
    executableRelativePath,
    executableSha256: await sha256File(executablePath),
    sourceArchiveSha256: `sha256:${archive.checksum}`,
    distributionReady: true,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function runGitVersion(executablePath) {
  const { stdout } = await execFileAsync(executablePath, ['--version'], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  return stdout;
}

function parseArchiveGitVersion(name) {
  const match = /^dugite-native-v(\d+\.\d+\.\d+)-/u.exec(name);
  if (!match) throw new Error(`dugite embedded Git archive name is invalid: ${name}`);
  return match[1];
}

async function requireRegularFile(path, label) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file: ${path}`);
  }
}

function assertWithin(root, target) {
  const rel = relative(resolve(root), resolve(target));
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..')) return;
  throw new Error(`Bundled Git executable escapes dugite root: ${target}`);
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = await prepareBundledGit();
  console.log(
    `Prepared bundled Git ${manifest.gitVersion} for ${manifest.platform}-${manifest.arch}.`,
  );
}
