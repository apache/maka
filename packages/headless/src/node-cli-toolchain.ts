import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PinnedNodeCliToolchainDefinition<TSpec> {
  label: string;
  fingerprint: string;
  spec: TSpec;
  node: {
    version: string;
    archiveUrl: string;
    archiveSha256: string;
    binarySha256: string;
  };
  packageArchive?: {
    url: string;
    integrity: `sha512-${string}`;
  };
  packageFiles: readonly {
    archivePath: string;
    installedPath: string;
    sha256: string;
    sourceSha256?: string;
    transform?: (source: string) => string;
    executable?: boolean;
    stripComponents?: number;
  }[];
}

export interface PreparedNodeCliToolchain {
  path: string;
  fingerprint: string;
}

export async function validatePreparedNodeCliToolchain<TSpec>(
  path: string,
  definition: PinnedNodeCliToolchainDefinition<TSpec>,
): Promise<PreparedNodeCliToolchain> {
  const manifest = parseManifest(
    await readFile(join(path, 'manifest.json'), 'utf8'),
    definition.label,
  );
  if (manifest.fingerprint !== definition.fingerprint) {
    throw new Error(`${definition.label} toolchain fingerprint mismatch: ${manifest.fingerprint}`);
  }
  if (JSON.stringify(manifest.spec) !== JSON.stringify(definition.spec)) {
    throw new Error(`${definition.label} toolchain spec does not match the pinned contract`);
  }
  const pinnedFiles = [
    { installedPath: 'bin/node', sha256: definition.node.binarySha256 },
    ...definition.packageFiles,
  ];
  const checksums: string[] = [];
  for (const file of pinnedFiles) {
    if ((await sha256File(join(path, file.installedPath))) !== file.sha256) {
      throw new Error(`${definition.label} toolchain ${file.installedPath} SHA-256 mismatch`);
    }
    checksums.push(`${file.sha256}  ${file.installedPath}\n`);
  }
  if ((await readFile(join(path, 'checksums.sha256'), 'utf8')) !== checksums.join('')) {
    throw new Error(`${definition.label} toolchain checksums.sha256 does not match its manifest`);
  }
  return { path, fingerprint: definition.fingerprint };
}

export async function prepareNodeCliToolchain<TSpec>(
  path: string,
  definition: PinnedNodeCliToolchainDefinition<TSpec>,
  options: { fetchFn?: typeof fetch } = {},
): Promise<PreparedNodeCliToolchain> {
  if (await exists(join(path, 'manifest.json')))
    return validatePreparedNodeCliToolchain(path, definition);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = await mkdtemp(join(dirname(path), `.${basename(path)}-`));
  try {
    const nodeArchive = join(temporaryPath, 'node.tar.gz');
    const packageArchive = definition.packageArchive
      ? join(temporaryPath, 'package.tgz')
      : undefined;
    await downloadVerified({
      url: definition.node.archiveUrl,
      path: nodeArchive,
      algorithm: 'sha256',
      expected: definition.node.archiveSha256,
      fetchFn: options.fetchFn ?? fetch,
    });
    if (definition.packageArchive && packageArchive) {
      await downloadVerified({
        url: definition.packageArchive.url,
        path: packageArchive,
        algorithm: 'sha512',
        expected: definition.packageArchive.integrity.slice('sha512-'.length),
        encoding: 'base64',
        fetchFn: options.fetchFn ?? fetch,
      });
    } else if (definition.packageFiles.length > 0) {
      throw new Error(`${definition.label} toolchain package files require a package archive`);
    }
    await mkdir(join(temporaryPath, 'bin'));
    await execFileAsync('tar', [
      '-xzf',
      nodeArchive,
      '-C',
      join(temporaryPath, 'bin'),
      '--strip-components=2',
      `node-v${definition.node.version}-linux-x64/bin/node`,
    ]);
    await chmod(join(temporaryPath, 'bin', 'node'), 0o755);
    for (const file of definition.packageFiles) {
      const installedPath = join(temporaryPath, file.installedPath);
      const targetDir = dirname(installedPath);
      await mkdir(targetDir, { recursive: true });
      if (!packageArchive) {
        throw new Error(`${definition.label} toolchain package files require a package archive`);
      }
      await execFileAsync('tar', [
        '-xzf',
        packageArchive,
        '-C',
        targetDir,
        `--strip-components=${file.stripComponents ?? 2}`,
        file.archivePath,
      ]);
      if (file.transform !== undefined) {
        if (file.sourceSha256 === undefined) {
          throw new Error(`${definition.label} toolchain transform requires a source SHA-256`);
        }
        if ((await sha256File(installedPath)) !== file.sourceSha256) {
          throw new Error(
            `${definition.label} toolchain ${file.installedPath} source SHA-256 mismatch`,
          );
        }
        await writeFile(
          installedPath,
          file.transform(await readFile(installedPath, 'utf8')),
          'utf8',
        );
      }
      if (file.executable) await chmod(installedPath, 0o755);
    }
    await writeFile(
      join(temporaryPath, 'manifest.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          fingerprint: definition.fingerprint,
          spec: definition.spec,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    await writeFile(
      join(temporaryPath, 'checksums.sha256'),
      [
        { installedPath: 'bin/node', sha256: definition.node.binarySha256 },
        ...definition.packageFiles,
      ]
        .map((file) => `${file.sha256}  ${file.installedPath}\n`)
        .join(''),
      'utf8',
    );
    await rm(nodeArchive);
    if (packageArchive) await rm(packageArchive);
    await validatePreparedNodeCliToolchain(temporaryPath, definition);
    try {
      await rename(temporaryPath, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      await validatePreparedNodeCliToolchain(path, definition);
    }
    return { path, fingerprint: definition.fingerprint };
  } finally {
    await rm(temporaryPath, { recursive: true, force: true });
  }
}

function parseManifest(raw: string, label: string): { fingerprint: string; spec: unknown } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} toolchain manifest is not valid JSON`, { cause: error });
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isRecord(value.spec) ||
    typeof value.fingerprint !== 'string'
  ) {
    throw new Error(`${label} toolchain manifest has an invalid shape`);
  }
  return { fingerprint: value.fingerprint, spec: value.spec };
}

async function downloadVerified(input: {
  url: string;
  path: string;
  algorithm: 'sha256' | 'sha512';
  expected: string;
  encoding?: 'hex' | 'base64';
  fetchFn: typeof fetch;
}): Promise<void> {
  const response = await input.fetchFn(input.url);
  if (!response.ok) throw new Error(`failed to download ${input.url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = createHash(input.algorithm)
    .update(bytes)
    .digest(input.encoding ?? 'hex');
  if (actual !== input.expected) throw new Error(`archive checksum mismatch for ${input.url}`);
  await writeFile(input.path, bytes);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
