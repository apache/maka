/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
export const DEFAULT_CAPSULE_TAG = 'compat-capsules';
export const FIRST_CAPSULE_ASSET = 'capsule-first-nightly.tar.gz';
export const CANONICAL_CAPSULE_DIR = '/tmp/maka-compat-capsule-v1';

function parseArgs(argv) {
  const [subcommand, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) throw new Error(`Unexpected positional argument: ${token}`);
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return { subcommand, flags };
}

function requireFlag(flags, key) {
  const value = flags[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing required option --${key}`);
  }
  return value;
}

/**
 * Rolling nightly capsule retention policy:
 * - Never prune pinned baselines (capsule-first-*) or milestones (capsule-milestone-*).
 * - Keep at most maxRolling newest capsule-nightly-*.tar.gz assets (ordered by creation time / name).
 */
export function selectPrunableCapsules(assets, maxRolling = 3) {
  const rolling = assets
    .filter(
      (asset) =>
        asset.name.startsWith('capsule-nightly-') &&
        asset.name.endsWith('.tar.gz') &&
        !asset.name.startsWith('capsule-first-') &&
        !asset.name.startsWith('capsule-milestone-'),
    )
    .sort((a, b) => {
      const ta = Date.parse(a.created_at ?? '') || 0;
      const tb = Date.parse(b.created_at ?? '') || 0;
      if (ta !== tb) return tb - ta;
      return b.name.localeCompare(a.name);
    });
  return rolling.slice(Math.max(0, maxRolling)).map((asset) => asset.name);
}

function runUpgradeHarness({ bin, testBin, envExtra }) {
  const resolvedBin = resolve(bin);
  if (!existsSync(resolvedBin)) {
    throw new Error(`maka binary not found: ${resolvedBin}`);
  }
  const env = {
    ...process.env,
    MAKA_COMPAT_BIN: resolvedBin,
    ...envExtra,
  };
  if (testBin) {
    execFileSync(resolve(testBin), ['--exact', 'upgrade_compat_capsule_roundtrip', '--nocapture'], {
      cwd: repoRoot,
      env,
      stdio: 'inherit',
    });
  } else {
    execFileSync(
      'cargo',
      [
        'test',
        '--locked',
        '-p',
        'maka-cli',
        '--test',
        'upgrade_compat',
        '--',
        '--exact',
        'upgrade_compat_capsule_roundtrip',
        '--nocapture',
      ],
      { cwd: repoRoot, env, stdio: 'inherit' },
    );
  }
}

export function produceCapsule({ bin, out, testBin, workDir = CANONICAL_CAPSULE_DIR }) {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  try {
    runUpgradeHarness({
      bin,
      testBin,
      envExtra: { MAKA_COMPAT_PRODUCE_CAPSULE: workDir },
    });
    const manifestPath = join(workDir, 'capsule-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const outPath = resolve(out);
    mkdirSync(dirname(outPath), { recursive: true });
    execFileSync('tar', ['-czf', outPath, '-C', workDir, '.'], { stdio: 'inherit' });
    const sizeBytes = statSync(outPath).size;
    console.log(
      `Sealed capsule ${basename(outPath)} (${sizeBytes} bytes, version=${manifest.makaVersion}, ledgers=${Object.keys(manifest.migrations ?? {}).length})`,
    );
    return { outPath, sizeBytes, manifest };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function normalizeCanonicalPath(dirPath) {
  return resolve(dirPath).replace(/^\/private\/tmp(\/|$)/, '/tmp$1');
}

function readTarManifest(capsulePath) {
  const probeDir = mkdtempSync(join(tmpdir(), 'maka-capsule-probe-'));
  try {
    for (const member of ['./capsule-manifest.json', 'capsule-manifest.json']) {
      try {
        execFileSync('tar', ['-xzf', capsulePath, '-C', probeDir, member], { stdio: 'pipe' });
        const manifestPath = join(probeDir, 'capsule-manifest.json');
        if (existsSync(manifestPath)) {
          return JSON.parse(readFileSync(manifestPath, 'utf8'));
        }
      } catch {
        // Try alternate archive member path.
      }
    }
    throw new Error(`Capsule archive missing capsule-manifest.json: ${capsulePath}`);
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

export function verifyCapsule({ bin, capsule, testBin }) {
  const capsulePath = resolve(capsule);
  if (!existsSync(capsulePath)) {
    throw new Error(`Capsule path not found: ${capsulePath}`);
  }
  const isDir = statSync(capsulePath).isDirectory();
  let cleanupDir = null;
  try {
    let targetDir = capsulePath;
    if (!isDir) {
      // Validate baseDir before touching CANONICAL_CAPSULE_DIR; never allow
      // archive metadata to select an arbitrary rmSync target.
      const probed = readTarManifest(capsulePath);
      if (
        typeof probed.baseDir !== 'string' ||
        normalizeCanonicalPath(probed.baseDir) !== normalizeCanonicalPath(CANONICAL_CAPSULE_DIR)
      ) {
        throw new Error(
          `Capsule ${basename(capsulePath)} baseDir (${String(probed.baseDir)}) does not match canonical mount ${CANONICAL_CAPSULE_DIR}`,
        );
      }
      rmSync(CANONICAL_CAPSULE_DIR, { recursive: true, force: true });
      mkdirSync(CANONICAL_CAPSULE_DIR, { recursive: true });
      cleanupDir = CANONICAL_CAPSULE_DIR;
      execFileSync('tar', ['-xzf', capsulePath, '-C', CANONICAL_CAPSULE_DIR], { stdio: 'inherit' });
      targetDir = CANONICAL_CAPSULE_DIR;
    }
    const manifestPath = join(targetDir, 'capsule-manifest.json');
    if (!existsSync(manifestPath)) {
      throw new Error(`Capsule missing capsule-manifest.json: ${capsulePath}`);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    console.log(
      `Verifying upgrade from capsule ${basename(capsulePath)} (source=${manifest.makaVersion}, sha=${manifest.gitSha ?? 'local'}) -> ${bin}`,
    );
    runUpgradeHarness({
      bin,
      testBin,
      envExtra: { MAKA_COMPAT_VERIFY_CAPSULE: targetDir },
    });
    console.log(`PASS: ${basename(capsulePath)}`);
  } finally {
    if (cleanupDir) rmSync(cleanupDir, { recursive: true, force: true });
  }
}

function queryReleaseByTag(repo, tag) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const apiUrl = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const url = `${apiUrl}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const headers = [
    '-H',
    'Accept: application/vnd.github+json',
    '-H',
    'X-GitHub-Api-Version: 2022-11-28',
  ];
  if (token) headers.push('-H', `Authorization: Bearer ${token}`);
  const bodyFile = join(mkdtempSync(join(tmpdir(), 'maka-gh-api-')), 'body.json');
  try {
    const httpCode = execFileSync(
      'curl',
      ['-sS', '-o', bodyFile, '-w', '%{http_code}', ...headers, url],
      { encoding: 'utf8' },
    ).trim();
    if (httpCode === '404') return null;
    if (httpCode !== '200') {
      const detail = existsSync(bodyFile) ? readFileSync(bodyFile, 'utf8') : '';
      throw new Error(
        `GitHub release lookup failed for ${repo}@${tag} (HTTP ${httpCode}): ${detail}`,
      );
    }
    return JSON.parse(readFileSync(bodyFile, 'utf8'));
  } finally {
    rmSync(dirname(bodyFile), { recursive: true, force: true });
  }
}

export function verifyReleaseCapsules({
  bin,
  repo,
  tag = DEFAULT_CAPSULE_TAG,
  testBin,
  requireExisting = false,
}) {
  const release = queryReleaseByTag(repo, tag);
  if (!release) {
    if (requireExisting) {
      throw new Error(`Expected compatibility capsule release ${repo}@${tag}, got HTTP 404`);
    }
    console.log(
      `No ${tag} release exists yet on ${repo} (pre-first-nightly bootstrap); skipping historical capsule replay.`,
    );
    return { verified: [] };
  }
  const capsules = (release.assets ?? [])
    .filter((asset) => asset.name.startsWith('capsule-') && asset.name.endsWith('.tar.gz'))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (capsules.length === 0) {
    throw new Error(
      `Release ${repo}@${tag} exists but contains zero capsule-*.tar.gz assets; refusing silent pass.`,
    );
  }
  if (!capsules.some((asset) => asset.name === FIRST_CAPSULE_ASSET)) {
    throw new Error(
      `Release ${repo}@${tag} is missing required permanent baseline asset ${FIRST_CAPSULE_ASSET}`,
    );
  }
  const downloadDir = mkdtempSync(join(tmpdir(), 'maka-capsule-dl-'));
  const failures = [];
  const verified = [];
  try {
    for (const asset of capsules) {
      execFileSync(
        'gh',
        ['release', 'download', tag, '--repo', repo, '--pattern', asset.name, '--dir', downloadDir],
        { stdio: 'inherit' },
      );
      const localTarball = join(downloadDir, asset.name);
      try {
        verifyCapsule({ bin, capsule: localTarball, testBin });
        verified.push(asset.name);
      } catch (error) {
        failures.push({ name: asset.name, error });
      }
    }
  } finally {
    rmSync(downloadDir, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    const names = failures.map((f) => f.name).join(', ');
    throw new Error(`Upgrade compatibility failed for ${failures.length} capsule(s): ${names}`);
  }
  console.log(`All ${verified.length} historical capsule(s) passed upgrade verification.`);
  return { verified };
}

export function publishCapsule({ capsule, repo, name, tag = DEFAULT_CAPSULE_TAG, maxRolling = 3 }) {
  const capsulePath = resolve(capsule);
  if (!existsSync(capsulePath)) throw new Error(`Capsule tarball not found: ${capsulePath}`);
  const release = queryReleaseByTag(repo, tag);
  const existingNames = new Set((release?.assets ?? []).map((a) => a.name));
  const uploadDir = mkdtempSync(join(tmpdir(), 'maka-capsule-pub-'));
  try {
    const staged = join(uploadDir, name);
    execFileSync('cp', [capsulePath, staged]);
    const uploads = [staged];
    if (!release) {
      const firstStaged = join(uploadDir, FIRST_CAPSULE_ASSET);
      execFileSync('cp', [capsulePath, firstStaged]);
      uploads.push(firstStaged);
      const createArgs = [
        'release',
        'create',
        tag,
        ...uploads,
        '--repo',
        repo,
        '--prerelease',
        '--latest=false',
        '--title',
        'Upgrade Compatibility Capsules',
        '--notes',
        'Automated State Root time capsules used by post-merge CI and nightly release compatibility gates. Do not edit manually.',
      ];
      if (process.env.GITHUB_SHA) {
        createArgs.push('--target', process.env.GITHUB_SHA);
      }
      execFileSync('gh', createArgs, { stdio: 'inherit' });
    } else {
      if (!existingNames.has(FIRST_CAPSULE_ASSET)) {
        throw new Error(
          `Release ${repo}@${tag} already exists without ${FIRST_CAPSULE_ASSET}; refusing to backfill a later nightly as the permanent first-nightly baseline.`,
        );
      }
      execFileSync('gh', ['release', 'upload', tag, ...uploads, '--repo', repo, '--clobber'], {
        stdio: 'inherit',
      });
    }
  } finally {
    rmSync(uploadDir, { recursive: true, force: true });
  }

  const refreshed = queryReleaseByTag(repo, tag);
  const toDelete = selectPrunableCapsules(refreshed?.assets ?? [], maxRolling);
  for (const stale of toDelete) {
    console.log(`Pruning expired rolling capsule: ${stale}`);
    execFileSync('gh', ['release', 'delete-asset', tag, stale, '--repo', repo, '--yes'], {
      stdio: 'inherit',
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { subcommand, flags } = parseArgs(process.argv.slice(2));
  if (subcommand === 'produce') {
    produceCapsule({
      bin: requireFlag(flags, 'bin'),
      out: requireFlag(flags, 'out'),
      testBin: flags['test-bin'],
    });
  } else if (subcommand === 'verify') {
    verifyCapsule({
      bin: requireFlag(flags, 'bin'),
      capsule: requireFlag(flags, 'capsule'),
      testBin: flags['test-bin'],
    });
  } else if (subcommand === 'verify-release') {
    verifyReleaseCapsules({
      bin: requireFlag(flags, 'bin'),
      repo: requireFlag(flags, 'repo'),
      tag: flags.tag ?? DEFAULT_CAPSULE_TAG,
      testBin: flags['test-bin'],
      requireExisting: Boolean(flags['require-existing']),
    });
  } else if (subcommand === 'publish') {
    publishCapsule({
      capsule: requireFlag(flags, 'capsule'),
      repo: requireFlag(flags, 'repo'),
      name: requireFlag(flags, 'name'),
      tag: flags.tag ?? DEFAULT_CAPSULE_TAG,
      maxRolling: flags['max-rolling'] ? Number.parseInt(flags['max-rolling'], 10) : 3,
    });
  } else {
    console.error('Usage: compat-capsule.mjs produce|verify|verify-release|publish [options]');
    process.exit(2);
  }
}
