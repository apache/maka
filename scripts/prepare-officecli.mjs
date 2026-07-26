#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const manifestPath = join(repoRoot, 'apps', 'desktop', 'bundled-tools.json');
const toolsDir = join(repoRoot, 'apps', 'desktop', 'resources', 'tools');
const DEFAULT_FETCH_TIMEOUT_MS = 300_000;

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const officeCli = manifest.officecli;
const FETCH_TIMEOUT_MS = readPositiveIntEnv(
  'MAKA_OFFICECLI_FETCH_TIMEOUT_MS',
  DEFAULT_FETCH_TIMEOUT_MS,
);

export function officeCliTargetFor(platform, arch) {
  return officeCli.assets[`${platform}-${arch}`] ? { platform, arch } : null;
}

export function assetForTarget(platform, arch) {
  const asset = officeCli.assets[`${platform}-${arch}`];
  if (!asset) throw new Error(`Unsupported OfficeCLI target: ${platform}-${arch}`);
  return asset;
}

export function binaryNameForPlatform(platform) {
  return platform === 'win32' ? 'officecli.exe' : 'officecli';
}

export function officeCliDownloadUrl(version, asset) {
  return `https://github.com/${officeCli.repo}/releases/download/${version}/${asset}`;
}

export function officeCliSha256SumsUrl(version) {
  return `https://github.com/${officeCli.repo}/releases/download/${version}/SHA256SUMS`;
}

export function parseSha256Sums(text) {
  const entries = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match) entries.set(match[2].trim(), match[1].toLowerCase());
  }
  return entries;
}

export function sha256(data) {
  return createHash('sha256').update(Buffer.from(data)).digest('hex');
}

export function assertOfficeCliChecksums({ asset, actual, upstream, pinned }) {
  if (!/^[a-f0-9]{64}$/.test(pinned ?? '')) {
    throw new Error(`Missing repository-pinned checksum for ${asset}`);
  }
  if (upstream !== pinned) {
    throw new Error(
      `Upstream checksum for ${asset} does not match repository-pinned checksum: expected ${pinned}, got ${upstream}`,
    );
  }
  if (actual !== pinned) {
    throw new Error(`Checksum mismatch for ${asset}: expected ${pinned}, got ${actual}`);
  }
}

export function officeCliVersionMatches(stdout, expectedVersion) {
  const normalized = expectedVersion.replace(/^v/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${normalized}\\b`).test(stdout);
}

function readPositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer timeout in milliseconds`);
  }
  return parsed;
}

function isTimeoutError(error) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      (error.name === 'AbortError' || error.name === 'TimeoutError'),
  );
}

function officeCliTimeoutError(url) {
  return new Error(`Timed out downloading ${url} after ${FETCH_TIMEOUT_MS}ms`);
}

async function fetchWithTimeout(url) {
  try {
    return await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw officeCliTimeoutError(url);
    }
    throw error;
  }
}

async function fetchBytes(url) {
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  try {
    return await response.arrayBuffer();
  } catch (error) {
    if (isTimeoutError(error)) throw officeCliTimeoutError(url);
    throw error;
  }
}

async function fetchText(url) {
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  try {
    return await response.text();
  } catch (error) {
    if (isTimeoutError(error)) throw officeCliTimeoutError(url);
    throw error;
  }
}

async function verifyOfficeCliVersion(binaryPath, expectedVersion) {
  const { stdout } = await execFileAsync(binaryPath, ['--version'], {
    env: { ...process.env, OFFICECLI_SKIP_UPDATE: '1' },
  });
  if (!officeCliVersionMatches(stdout, expectedVersion)) {
    throw new Error(
      `OfficeCLI version mismatch: expected ${expectedVersion}, got ${stdout.trim()}`,
    );
  }
}

export async function prepareOfficeCli(
  targetPlatform = process.platform,
  targetArch = process.arch,
) {
  const target = `${targetPlatform}-${targetArch}`;
  const asset = assetForTarget(targetPlatform, targetArch);
  const assetUrl = officeCliDownloadUrl(officeCli.version, asset);
  const sums = parseSha256Sums(await fetchText(officeCliSha256SumsUrl(officeCli.version)));
  const upstream = sums.get(asset);
  if (!upstream) throw new Error(`SHA256SUMS does not include ${asset}`);

  const data = await fetchBytes(assetUrl);
  const actual = sha256(data);
  assertOfficeCliChecksums({
    asset,
    actual,
    upstream,
    pinned: officeCli.sha256?.[target],
  });

  await mkdir(toolsDir, { recursive: true });
  await rm(join(toolsDir, 'officecli'), { force: true });
  await rm(join(toolsDir, 'officecli.exe'), { force: true });
  const destination = join(toolsDir, binaryNameForPlatform(targetPlatform));
  await writeFile(destination, Buffer.from(data));
  if (targetPlatform !== 'win32') await chmod(destination, 0o755);

  if (targetPlatform === process.platform && targetArch === process.arch) {
    await verifyOfficeCliVersion(destination, officeCli.version);
  }

  return { asset, destination, version: officeCli.version };
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const platform = readArg('--platform') ?? process.platform;
  const arch = readArg('--arch') ?? process.arch;
  const result = await prepareOfficeCli(platform, arch);
  process.stdout.write(
    `Prepared OfficeCLI ${result.version} for ${platform}-${arch}: ${result.destination}\n`,
  );
}
