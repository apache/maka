#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  mkdtemp,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { dirname, join, relative, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  constants as zlibConstants,
  createBrotliCompress,
  createGzip,
  createZstdCompress,
  createZstdDecompress,
} from 'node:zlib';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const HARBOR_CELL_MODULE = resolve(REPO_ROOT, 'packages/headless/dist/harbor-cell.js');
const HEADLESS_STORAGE_MODULE = resolve(REPO_ROOT, 'packages/headless/dist/headless-storage.js');
const DEFAULT_BOOT_SAMPLES = 3;
const BUNDLE_SCHEMA_VERSION = 2;
export const DECISION_READY_MIN_SAMPLES = 100;
const SUPPORTED_OPTIONS = new Set([
  'workspace',
  'session-export',
  'iterations',
  'boot-samples',
  'provider-ttfb-ms',
  'help',
]);
// Storage-root authority markers bind a directory to its host device/inode and
// must be regenerated when a session export is materialized elsewhere.
const STORAGE_ROOT_AUTHORITY_MARKER = '.maka-storage-root.json';
const EXCLUDED_WORKSPACE_SEGMENTS = new Set(['.git', 'node_modules']);
const SENSITIVE_WORKSPACE_FILE_PATTERNS = [
  /^\.env(?:\..*)?$/i,
  /^\.(?:npmrc|netrc|pypirc|terraformrc)$/i,
  /^\.git-credentials(?:\.lock)?$/i,
  /^(?:credentials?|secrets?)(?:\..*)?$/i,
  /(?:^|[-_.])(?:id_(?:rsa|dsa|ecdsa|ed25519)|private[-_.]?key)(?:$|[-_.])/i,
  /\.(?:key|pem|p12|pfx|der|crt|cer|csr|log)$/i,
];
const SENSITIVE_KEY_PARTS = new Set([
  'api_key',
  'access_key',
  'access_token',
  'authorization',
  'client_secret',
  'cookie',
  'credential',
  'credentials',
  'password',
  'passwd',
  'private_key',
  'refresh_token',
  'secret',
]);
const SENSITIVE_COMPACT_KEY_PARTS = new Set([
  'apikey',
  'accesskey',
  'accesstoken',
  'authtoken',
  'clientsecret',
  'idtoken',
  'privatekey',
  'refreshtoken',
  'sessiontoken',
]);
const NON_SECRET_KEY_NAMES = new Set(['agentSwarmAuthorization', 'author']);
const SECRET_PATTERNS = [
  /((?:authorization|x-api-key|api-key)\s*:\s*)(?:bearer\s+|basic\s+)?[^\s,;"']+/gi,
  /([?&](?:api[-_]?key|access[-_]?token|auth[-_]?token|token|password|secret)=)[^&#\s]+/gi,
  /((?:api[-_]?key|auth[-_]?token|access[-_]?token|password|secret|token|cookie|set-cookie)\s*[:=]\s*)["'][^"']*["']|((?:api[-_]?key|auth[-_]?token|access[-_]?token|password|secret|token|cookie|set-cookie)\s*[:=]\s*)[^\s,;]+/gi,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_-]{8,}/g,
];

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  if (process.argv[2] === '--child-bootstrap') {
    await childBootstrap(process.argv[3]);
  } else {
    await main(parseArgs(process.argv.slice(2)));
  }
}

async function main(options) {
  const workspaceRoot = resolve(options.workspace ?? process.cwd());
  const exportRoots = options['session-export'] ?? [];
  const iterations = positiveInteger(
    options.iterations ?? (exportRoots.length > 0 ? exportRoots.length : 1),
    'iterations',
  );
  const bootSamples = positiveInteger(
    options['boot-samples'] ?? DEFAULT_BOOT_SAMPLES,
    'boot-samples',
  );
  const providerTtfbMs =
    options['provider-ttfb-ms'] === undefined
      ? undefined
      : nonNegativeNumber(options['provider-ttfb-ms'], 'provider-ttfb-ms');
  if (exportRoots.length > 0 && iterations > exportRoots.length) {
    throw new Error(
      `--iterations (${iterations}) cannot exceed the number of --session-export paths (${exportRoots.length}); do not duplicate real sessions in a percentile report`,
    );
  }
  if (exportRoots.length === 0 && iterations !== 1) {
    throw new Error(
      '--iterations must be 1 unless --session-export is supplied; do not duplicate the smoke fixture',
    );
  }
  const sourceRoots = await Promise.all(exportRoots.map((path) => realpath(resolve(path))));
  if (new Set(sourceRoots).size !== sourceRoots.length) {
    throw new Error('each --session-export path must be unique; do not duplicate real sessions');
  }
  const sourceSessionIds = [];
  for (const sourceRoot of sourceRoots) {
    sourceSessionIds.push(await readSessionExportId(sourceRoot));
  }
  if (new Set(sourceSessionIds).size !== sourceSessionIds.length) {
    throw new Error('each --session-export must contain a unique session id');
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'maka-session-bundle-measure-'));
  try {
    const workspace = await measureWorkspace(workspaceRoot);
    const workspaceEntries = await readTreeEntries(workspaceRoot, {
      excludeWorkspaceDirectories: true,
    });
    const measuredSourceRoots =
      exportRoots.length > 0 ? sourceRoots : [await createBootstrapSmokeExport(temporaryRoot)];
    const samples = [];

    for (let index = 0; index < iterations; index += 1) {
      const sampleRoot = join(temporaryRoot, `sample-${String(index + 1).padStart(3, '0')}`);
      const stateRoot = join(sampleRoot, 'state');
      const sourceRoot = measuredSourceRoots[index];
      await prepareStateExport(sourceRoot, stateRoot);
      const archivePath = join(sampleRoot, 'session-bundle.tar.zst');
      const archive = await createBundleArchive({ stateRoot, workspaceEntries, archivePath });
      const hydrateSamples = [];
      const bootSamplesForSample = [];
      for (let repeat = 0; repeat < bootSamples; repeat += 1) {
        hydrateSamples.push(await measureHydrate(archivePath));
        bootSamplesForSample.push(await measureBoot(archivePath));
      }
      samples.push({
        id: archive.sessionId,
        source: exportRoots[index] ? 'sanitized-real-session-export' : 'fake-bootstrap-smoke',
        rawStateBytes: archive.rawStateBytes,
        rawTarBytes: archive.rawTarBytes,
        compressedBytes: archive.compressedBytes,
        hydrateMs: percentileStats(hydrateSamples),
        freshProcessBootstrapMs: percentileStats(bootSamplesForSample),
        hydrateSamples,
        bootSamples: bootSamplesForSample,
      });
    }

    const evidenceKind =
      exportRoots.length > 0 ? 'sanitized-real-session-exports' : 'fake-bootstrap-smoke-only';
    const report = {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      measuredAt: new Date().toISOString(),
      node: process.version,
      evidence: {
        kind: evidenceKind,
        sampleCount: samples.length,
        decisionReady: isDecisionReady(evidenceKind, samples.length),
        decisionReadyMinSamples: DECISION_READY_MIN_SAMPLES,
        sourceCount: exportRoots.length,
        note:
          exportRoots.length > 0
            ? 'Session exports are expected to be sanitized before measurement; JSON text receives a defense-in-depth redaction pass.'
            : 'This run exercises the archive and bootstrap smoke path only. It is not evidence from real coding sessions and must not be used to set a capacity or latency SLO.',
      },
      archive: {
        format: 'tar.zst',
        schemaVersion: BUNDLE_SCHEMA_VERSION,
        layout: ['manifest.json', 'state/**', 'workspace/**'],
        rawTarBytes: statsFor(samples.map((sample) => sample.rawTarBytes)),
        zstdBytes: statsFor(samples.map((sample) => sample.compressedBytes.zstd)),
      },
      workspace: {
        ...workspace,
        archivedPortableRawBytes: workspaceEntries.reduce((total, entry) => total + entry.bytes, 0),
      },
      samples: samples.map((sample) => ({
        id: sample.id,
        source: sample.source,
        rawStateBytes: sample.rawStateBytes,
        rawTarBytes: sample.rawTarBytes,
        compressedBytes: sample.compressedBytes,
        hydrateMs: sample.hydrateMs,
        freshProcessBootstrapMs: sample.freshProcessBootstrapMs,
      })),
      coldStart: {
        providerTtfbMs: providerTtfbMs ?? null,
        providerTtfbSource:
          providerTtfbMs === undefined
            ? 'not supplied; planning estimate omitted'
            : 'explicit CLI input; planning assumption, not a live provider measurement',
        hydrateMs: statsFor(samples.flatMap((sample) => sample.hydrateSamples)),
        freshProcessBootstrapMs: statsFor(samples.flatMap((sample) => sample.bootSamples)),
        ...(providerTtfbMs === undefined
          ? {}
          : {
              planningEstimateFirstTokenMs: statsFor(
                samples.flatMap((sample) =>
                  sample.bootSamples.map((duration) => duration + providerTtfbMs),
                ),
              ),
            }),
      },
      notes: [
        'The archive is a real POSIX tar stream compressed with Node native Zstandard.',
        'Fresh-process bootstrap extracts the archive, reads the materialized storage, rebases restored paths, constructs the Harbor cell runtime, and records local readiness before FakeBackend latency while still validating clean turn completion.',
        'The provider TTFB input and any budget derived from it are assumptions; this command does not measure provider latency.',
      ],
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function createBootstrapSmokeExport(temporaryRoot) {
  const storageRoot = join(temporaryRoot, 'smoke-storage');
  const outputDir = join(temporaryRoot, 'smoke-output');
  const workspaceDir = join(temporaryRoot, 'smoke-workspace');
  await mkdir(workspaceDir, { recursive: true });
  let runHarborCell;
  try {
    ({ runHarborCell } = await import(pathToFileURL(HARBOR_CELL_MODULE).href));
  } catch (error) {
    throw new Error(
      `The real bootstrap smoke path requires built headless artifacts at ${HARBOR_CELL_MODULE}; run the workspace build first (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  await runHarborCell({
    config: {
      id: 'session-bundle-measurement-smoke',
      backend: 'fake',
      llmConnectionSlug: 'fixture',
      model: 'fixture-model',
    },
    instruction: 'Inspect the fixture workspace and report one safe improvement.',
    cwd: workspaceDir,
    outputDir,
    storageRoot,
  });
  return storageRoot;
}

async function prepareStateExport(sourceRoot, destinationRoot) {
  const source = resolve(sourceRoot);
  const sourceStats = await stat(source).catch(() => undefined);
  if (!sourceStats?.isDirectory()) throw new Error(`session export is not a directory: ${source}`);
  const entries = await readTreeEntries(source);
  if (!entries.some((entry) => entry.path.startsWith('sessions/'))) {
    throw new Error(`session export has no sessions/** tree: ${source}`);
  }
  for (const entry of entries) {
    if (entry.path === STORAGE_ROOT_AUTHORITY_MARKER) continue;
    const destination = join(destinationRoot, entry.path);
    await mkdir(dirname(destination), { recursive: true });
    if (isJsonTextPath(entry.path)) {
      await writeFile(destination, sanitizeJsonText(entry.path, await readFile(entry.sourcePath)));
    } else {
      await pipeline(createReadStream(entry.sourcePath), createWriteStream(destination));
    }
  }
}

async function createBundleArchive({ stateRoot, workspaceEntries, archivePath }) {
  const stateEntries = await readTreeEntries(stateRoot);
  const sessionId = findSessionId(stateEntries);
  const files = [
    ...stateEntries.map((entry) => ({ ...entry, path: `state/${entry.path}` })),
    ...workspaceEntries.map((entry) => ({ ...entry, path: `workspace/${entry.path}` })),
  ].sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    format: 'maka-session-bundle',
    sessionId,
    stateRoot: 'state',
    workspaceRoot: 'workspace',
    files: await hashManifestFiles(files),
  };
  await mkdir(dirname(archivePath), { recursive: true });
  const tarPath = `${archivePath}.raw-tar`;
  try {
    await writeTarFile(tarPath, [
      { path: 'manifest.json', bytes: Buffer.from(`${JSON.stringify(manifest)}\n`) },
      ...files,
    ]);
    const rawTarBytes = (await stat(tarPath)).size;
    const [gzip, brotli] = await Promise.all([
      compressedStreamSize(tarPath, createGzip({ level: 6 })),
      compressedStreamSize(
        tarPath,
        createBrotliCompress({
          params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
        }),
      ),
    ]);
    await pipeline(
      createReadStream(tarPath),
      createZstdCompress({
        params: { [zlibConstants.ZSTD_c_compressionLevel]: 3 },
      }),
      createWriteStream(archivePath, { flags: 'wx' }),
    );
    const zstd = (await stat(archivePath)).size;
    const decompressedBytes = await compressedStreamSize(archivePath, createZstdDecompress());
    if (decompressedBytes !== rawTarBytes) {
      throw new Error('Zstandard round-trip changed the tar byte count');
    }
    return {
      sessionId,
      rawStateBytes: stateEntries.reduce((total, entry) => total + entry.bytes, 0),
      rawTarBytes,
      compressedBytes: { gzip, brotli, zstd },
    };
  } finally {
    await rm(tarPath, { force: true });
  }
}

export async function hashManifestFiles(files, hash = hashFile) {
  const records = [];
  for (const file of files) {
    records.push({
      path: file.path,
      bytes: file.bytes,
      sha256: await hash(file.sourcePath),
    });
  }
  return records;
}

async function measureHydrate(archivePath) {
  const destination = await mkdtemp(join(tmpdir(), 'maka-session-bundle-hydrate-'));
  const start = performance.now();
  try {
    const manifest = await extractTarZst(archivePath, destination);
    await validateMaterializedBundle(destination, manifest);
    return performance.now() - start;
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
}

function measureBoot(archivePath) {
  return measureChildReady(process.execPath, [SCRIPT_PATH, '--child-bootstrap', archivePath], {
    cwd: REPO_ROOT,
  });
}

export function measureChildReady(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const start = performance.now();
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: options.cwd,
      env: options.env,
    });
    let stdout = '';
    let stderr = '';
    let readyMs;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (readyMs === undefined && stdout.startsWith('ready\n')) {
        readyMs = performance.now() - start;
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 && stdout === 'ready\n' && readyMs !== undefined) {
        resolvePromise(readyMs);
      } else {
        reject(
          new Error(
            `bootstrap child exited with ${code ?? signal} before a valid ready signal: ${stderr}`,
          ),
        );
      }
    });
  });
}

async function childBootstrap(archivePath) {
  if (!archivePath) throw new Error('--child-bootstrap requires an archive path');
  const destination = await mkdtemp(join(tmpdir(), 'maka-session-bundle-bootstrap-'));
  try {
    const manifest = await extractTarZst(archivePath, destination);
    await validateMaterializedBundle(destination, manifest);
    const [{ runHarborCellWithStorage }, { openHeadlessStorageForWrite }] = await Promise.all([
      import(pathToFileURL(HARBOR_CELL_MODULE).href),
      import(pathToFileURL(HEADLESS_STORAGE_MODULE).href),
    ]);
    const storageRoot = join(destination, 'state');
    const workspaceDir = join(destination, 'workspace');
    const storage = await openHeadlessStorageForWrite(storageRoot);
    try {
      const sessions = await storage.executionStores.sessionStore.listForRecovery();
      if (sessions.length !== 1 || sessions[0].id !== manifest.sessionId) {
        throw new Error('materialized bundle must contain exactly the manifest session');
      }
      const session = sessions[0];
      await storage.executionStores.sessionStore.readMessagesForRecovery(session.id);
      await storage.executionStores.sessionStore.listTurnsSnapshot(session.id);
      await storage.executionStores.runtimeEventStore.readSessionRuntimeEvents(session.id);
      await storage.executionStores.sessionStore.updateHeader(session.id, {
        workspaceRoot: storageRoot,
        cwd: workspaceDir,
        backend: 'fake',
        llmConnectionSlug: 'fixture',
        model: 'fixture-model',
        permissionMode: 'execute',
      });
      const rebasedSession = await storage.executionStores.sessionStore.readHeaderSnapshot(
        session.id,
      );
      if (rebasedSession.workspaceRoot !== storageRoot || rebasedSession.cwd !== workspaceDir) {
        throw new Error('restored session paths were not rebased to the materialized bundle');
      }
      await runHarborCellWithStorage(
        {
          config: {
            id: 'session-bundle-bootstrap-probe',
            backend: 'fake',
            llmConnectionSlug: 'fixture',
            model: 'fixture-model',
          },
          instruction: 'bootstrap probe',
          cwd: workspaceDir,
          outputDir: join(destination, 'bootstrap-output'),
          storageRoot,
          resumeSessionId: session.id,
          onBootstrapReady: () => {
            process.stdout.write('ready\n');
          },
        },
        storage,
      );
      const after = await storage.executionStores.sessionStore.listForRecovery();
      if (after.length !== 1 || after[0].id !== session.id) {
        throw new Error('bootstrap created an unrelated session instead of restoring the export');
      }
    } finally {
      await storage.executionStores.sessionStore.close();
    }
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
}

async function extractTarZst(archivePath, destination) {
  const tarPath = join(destination, '.session-bundle.raw-tar');
  const files = [];
  try {
    await pipeline(
      createReadStream(archivePath),
      createZstdDecompress(),
      createWriteStream(tarPath, { flags: 'wx' }),
    );
    const tarStats = await stat(tarPath);
    if (tarStats.size < 1024) throw new Error('archive is not a POSIX ustar tar.zst');
    const handle = await open(tarPath, 'r');
    try {
      let offset = 0;
      while (offset + 512 <= tarStats.size) {
        const header = Buffer.alloc(512);
        const { bytesRead } = await handle.read(header, 0, header.length, offset);
        if (bytesRead !== header.length) throw new Error('truncated tar header');
        if (header.every((byte) => byte === 0)) break;
        if (header.subarray(257, 262).toString('ascii') !== 'ustar') {
          throw new Error('archive is not a POSIX ustar tar.zst');
        }
        const name = readTarString(header, 0, 100);
        const prefix = readTarString(header, 345, 155);
        const path = prefix ? `${prefix}/${name}` : name;
        const size = parseTarOctal(header.subarray(124, 136));
        const type = header[156];
        if (!path || type !== 0) throw new Error(`unsupported tar entry: ${path}`);
        assertSafeArchivePath(path);
        const bodyStart = offset + 512;
        const bodyEnd = bodyStart + size;
        if (bodyEnd > tarStats.size) throw new Error(`truncated tar entry: ${path}`);
        const destinationPath = join(destination, path);
        await mkdir(dirname(destinationPath), { recursive: true });
        if (size === 0) await writeFile(destinationPath, Buffer.alloc(0), { flag: 'wx' });
        else {
          await pipeline(
            createReadStream(tarPath, { start: bodyStart, end: bodyEnd - 1 }),
            createWriteStream(destinationPath, { flags: 'wx' }),
          );
        }
        files.push({ path, bytes: size });
        offset = bodyStart + Math.ceil(size / 512) * 512;
      }
    } finally {
      await handle.close();
    }
  } finally {
    await rm(tarPath, { force: true });
  }
  const manifest = JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8'));
  if (
    manifest.schemaVersion !== BUNDLE_SCHEMA_VERSION ||
    manifest.format !== 'maka-session-bundle'
  ) {
    throw new Error('unsupported session bundle manifest');
  }
  validateManifest(manifest);
  await mkdir(join(destination, manifest.stateRoot), { recursive: true });
  await mkdir(join(destination, manifest.workspaceRoot), { recursive: true });
  const archivePathSet = new Set();
  for (const file of files) {
    if (archivePathSet.has(file.path)) throw new Error(`duplicate archive entry: ${file.path}`);
    archivePathSet.add(file.path);
  }
  const manifestPaths = new Set(manifest.files.map((file) => file.path));
  const archivePaths = files
    .filter((file) => file.path !== 'manifest.json')
    .map((file) => file.path);
  if (
    archivePaths.length !== manifestPaths.size ||
    archivePaths.some((path) => !manifestPaths.has(path))
  ) {
    throw new Error('manifest does not exactly match archive entries');
  }
  return manifest;
}

async function validateMaterializedBundle(destination, manifest) {
  validateManifest(manifest);
  const stateRoot = join(destination, manifest.stateRoot);
  const workspaceRoot = join(destination, manifest.workspaceRoot);
  const sessionPath = join(stateRoot, 'sessions', manifest.sessionId, 'session.jsonl');
  await stat(sessionPath);
  await stat(workspaceRoot);
  for (const file of manifest.files) {
    const path = join(destination, file.path);
    const bytes = (await stat(path)).size;
    if (bytes !== file.bytes) throw new Error(`bundle byte count mismatch: ${file.path}`);
    const digest = await hashFile(path);
    if (digest !== file.sha256) throw new Error(`bundle digest mismatch: ${file.path}`);
  }
}

async function measureWorkspace(root) {
  const categories = { git: 0, nodeModules: 0, sensitive: 0, portableWorkspace: 0 };
  await walkFiles(root, async (path, relativePath) => {
    const bytes = (await stat(path)).size;
    const category = excludedWorkspaceCategory(relativePath);
    if (category === 'git') categories.git += bytes;
    else if (category === 'nodeModules') categories.nodeModules += bytes;
    else if (category === 'sensitive') categories.sensitive += bytes;
    else categories.portableWorkspace += bytes;
  });
  return {
    rawBytes:
      categories.git + categories.nodeModules + categories.sensitive + categories.portableWorkspace,
    categories,
  };
}

async function readTreeEntries(root, options = {}) {
  const files = [];
  await walkFiles(root, async (path, relativePath) => {
    if (options.excludeWorkspaceDirectories && excludedWorkspaceCategory(relativePath)) return;
    files.push({ path: relativePath, sourcePath: path, bytes: (await stat(path)).size });
  });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

async function readSessionExportId(root) {
  const sessionsRoot = join(root, 'sessions');
  const entries = await readdir(sessionsRoot, { withFileTypes: true }).catch(() => []);
  const sessionIds = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionPath = join(sessionsRoot, entry.name, 'session.jsonl');
    const sessionStats = await stat(sessionPath).catch(() => undefined);
    if (sessionStats?.isFile()) sessionIds.push(entry.name);
  }
  if (sessionIds.length === 0)
    throw new Error('state export must contain sessions/<id>/session.jsonl');
  if (sessionIds.length !== 1)
    throw new Error('each session export must contain exactly one sessions/<id>/session.jsonl');
  return sessionIds[0];
}

async function walkFiles(root, onFile, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(current, entry.name);
    const relativePath = relative(root, path).split('\\').join('/');
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await walkFiles(root, onFile, path);
    else if (entry.isFile()) await onFile(path, relativePath);
  }
}

function excludedWorkspaceCategory(relativePath) {
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment === '.git')) return 'git';
  if (
    segments.some(
      (segment) => EXCLUDED_WORKSPACE_SEGMENTS.has(segment) && segment === 'node_modules',
    )
  ) {
    return 'nodeModules';
  }
  const basename = segments.at(-1) ?? '';
  if (
    (segments.at(-2) === '.docker' && basename === 'config.json') ||
    (segments.at(-2) === '.aws' && basename === 'credentials') ||
    (segments.at(-2) === '.cargo' && basename === 'credentials') ||
    (segments.at(-2) === '.kube' && basename === 'config') ||
    (segments.at(-2) === 'gcloud' &&
      segments.at(-3) === '.config' &&
      basename === 'application_default_credentials.json')
  ) {
    return 'sensitive';
  }
  if (SENSITIVE_WORKSPACE_FILE_PATTERNS.some((pattern) => pattern.test(basename))) {
    return 'sensitive';
  }
  return undefined;
}

function findSessionId(entries) {
  const sessionIds = [
    ...new Set(
      entries.flatMap((entry) => {
        const match = /^sessions\/([^/]+)\/session\.jsonl$/.exec(entry.path);
        return match ? [match[1]] : [];
      }),
    ),
  ];
  if (sessionIds.length === 0)
    throw new Error('state export must contain sessions/<id>/session.jsonl');
  if (sessionIds.length !== 1)
    throw new Error('each session export must contain exactly one sessions/<id>/session.jsonl');
  return sessionIds[0];
}

export function isDecisionReady(evidenceKind, sampleCount) {
  return (
    evidenceKind === 'sanitized-real-session-exports' && sampleCount >= DECISION_READY_MIN_SAMPLES
  );
}

function isJsonTextPath(path) {
  return path.endsWith('.json') || path.endsWith('.jsonl');
}

function sanitizeJsonText(path, bytes) {
  const text = bytes.toString('utf8');
  if (path.endsWith('.jsonl')) {
    return Buffer.from(
      text
        .split('\n')
        .map((line) => {
          if (!line.trim()) return line;
          try {
            return `${JSON.stringify(redactJson(JSON.parse(line)))}\n`;
          } catch {
            return `${redactText(line)}\n`;
          }
        })
        .join(''),
    );
  }
  try {
    return Buffer.from(`${JSON.stringify(redactJson(JSON.parse(text)), null, 2)}\n`);
  } catch {
    return Buffer.from(redactText(text));
  }
}

function redactJson(value) {
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        isSensitiveKey(key) && !NON_SECRET_KEY_NAMES.has(key) ? '[REDACTED]' : redactJson(nested),
      ]),
    );
  }
  return typeof value === 'string' ? redactText(value) : value;
}

function isSensitiveKey(key) {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replaceAll('-', '_')
    .toLowerCase();
  const compact = normalized.replaceAll('_', '');
  return (
    normalized === 'token' ||
    normalized.endsWith('_token') ||
    SENSITIVE_KEY_PARTS.has(normalized) ||
    [...SENSITIVE_KEY_PARTS].some((part) => normalized.endsWith(`_${part}`)) ||
    [...SENSITIVE_COMPACT_KEY_PARTS].some((part) => compact.endsWith(part))
  );
}

export function redactText(value) {
  return SECRET_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, (...args) => {
        const groups = args.slice(1, -2);
        const prefix = groups.find((group) => typeof group === 'string' && /[:=?&\s]$/.test(group));
        return `${prefix ?? ''}[REDACTED]`;
      }),
    value,
  );
}

async function writeTarFile(path, entries) {
  const handle = await open(path, 'wx');
  let offset = 0;
  const write = async (bytes) => {
    await handle.write(bytes, 0, bytes.byteLength, offset);
    offset += bytes.byteLength;
  };
  try {
    for (const entry of entries) {
      assertSafeArchivePath(entry.path);
      const size = Buffer.isBuffer(entry.bytes) ? entry.bytes.byteLength : entry.bytes;
      const { name, prefix } = splitTarPath(entry.path);
      const header = Buffer.alloc(512, 0);
      writeTarString(header, 0, 100, name);
      writeTarOctal(header, 100, 8, 0o644);
      writeTarOctal(header, 108, 8, 0);
      writeTarOctal(header, 116, 8, 0);
      writeTarOctal(header, 124, 12, size);
      writeTarOctal(header, 136, 12, 0);
      header.fill(0x20, 148, 156);
      header[156] = 0;
      writeTarString(header, 257, 6, 'ustar');
      writeTarString(header, 263, 2, '00');
      writeTarString(header, 345, 155, prefix);
      const checksum = header.reduce((total, byte) => total + byte, 0);
      writeTarChecksum(header, checksum);
      await write(header);
      if (Buffer.isBuffer(entry.bytes)) {
        await write(entry.bytes);
      } else {
        for await (const chunk of createReadStream(entry.sourcePath)) {
          await write(chunk);
        }
      }
      const padding = (512 - (size % 512)) % 512;
      if (padding > 0) await write(Buffer.alloc(padding));
    }
    await write(Buffer.alloc(1024));
  } finally {
    await handle.close();
  }
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function compressedStreamSize(path, transform) {
  let bytes = 0;
  await pipeline(
    createReadStream(path),
    transform,
    new Writable({
      write(chunk, _encoding, callback) {
        bytes += chunk.byteLength;
        callback();
      },
    }),
  );
  return bytes;
}

function splitTarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  const slashPositions = [];
  for (let index = 0; index < path.length; index += 1) {
    if (path[index] === '/') slashPositions.push(index);
  }
  for (const slash of slashPositions.reverse()) {
    const prefix = path.slice(0, slash);
    const name = path.slice(slash + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`tar path is too long for ustar prefix/name fields: ${path}`);
}

function writeTarString(buffer, offset, length, value) {
  buffer.write(value, offset, length, 'utf8');
}

function writeTarOctal(buffer, offset, length, value) {
  const text = Math.floor(value)
    .toString(8)
    .padStart(length - 1, '0');
  buffer.write(`${text}\0`, offset, length, 'ascii');
}

function writeTarChecksum(buffer, value) {
  buffer.write(`${value.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
}

function readTarString(buffer, offset, length) {
  return buffer
    .subarray(offset, offset + length)
    .toString('utf8')
    .replace(/\0.*$/, '');
}

function parseTarOctal(buffer) {
  const value = buffer.toString('ascii').replace(/\0.*$/, '').trim();
  const parsed = value ? Number.parseInt(value, 8) : 0;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('invalid tar size');
  return parsed;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('invalid session bundle manifest');
  }
  if (
    typeof manifest.sessionId !== 'string' ||
    !manifest.sessionId ||
    manifest.sessionId.includes('/') ||
    typeof manifest.stateRoot !== 'string' ||
    typeof manifest.workspaceRoot !== 'string' ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error('invalid session bundle manifest');
  }
  assertSafeArchivePath(manifest.stateRoot);
  assertSafeArchivePath(manifest.workspaceRoot);
  const seen = new Set();
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file !== 'object' ||
      typeof file.path !== 'string' ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      file.path === 'manifest.json' ||
      seen.has(file.path)
    ) {
      throw new Error('invalid session bundle manifest file');
    }
    assertSafeArchivePath(file.path);
    if (
      !file.path.startsWith(`${manifest.stateRoot}/`) &&
      !file.path.startsWith(`${manifest.workspaceRoot}/`)
    ) {
      throw new Error(`manifest file outside bundle roots: ${file.path}`);
    }
    seen.add(file.path);
  }
}

function assertSafeArchivePath(path) {
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`unsafe archive path: ${path}`);
  }
}

function statsFor(values) {
  return {
    min: round(percentile(values, 0)),
    p50: round(percentile(values, 0.5)),
    p99: round(percentile(values, 0.99)),
    max: round(percentile(values, 1)),
  };
}

function percentileStats(values) {
  return {
    p50: round(percentile(values, 0.5)),
    p99: round(percentile(values, 0.99)),
  };
}

function percentile(values, probability) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  if (probability <= 0) return sorted[0];
  if (probability >= 1) return sorted[sorted.length - 1];
  return sorted[Math.min(sorted.length - 1, Math.ceil(probability * sorted.length) - 1)];
}

function parseArgs(argv) {
  const options = { 'session-export': [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unknown argument: ${argument}`);
    const key = argument.slice(2);
    if (!SUPPORTED_OPTIONS.has(key)) throw new Error(`Unknown option: --${key}`);
    if (key === 'help') {
      process.stdout.write(
        'Usage: node scripts/measure-session-bundle.mjs --workspace PATH [--session-export PATH ...] [--iterations N] [--boot-samples N] [--provider-ttfb-ms N]\n',
      );
      process.exit(0);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`Missing value for --${key}`);
    if (key === 'session-export') options[key].push(value);
    else options[key] = value;
    index += 1;
  }
  return options;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

function nonNegativeNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${name} must be non-negative`);
  return parsed;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
