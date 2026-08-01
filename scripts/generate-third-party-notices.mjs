import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const outputPath = join(repoRoot, 'apps/desktop/resources/licenses/npm/THIRD_PARTY_NOTICES.txt');
const checkOnly = process.argv.includes('--check');
const assetNoticePath = join(repoRoot, 'apps/desktop/src/renderer/public/THIRD_PARTY_LICENSES.txt');
const REQUIRED_ASSET_NOTICE_MARKERS = [
  '## Simple Icons brand marks',
  '## TDesign Icons WeCom mark',
  '## MingCute DingTalk mark',
  '## Allogo Feishu mark',
  '## Ant Design Icons DingTalk mark',
  '## Semi Design Feishu mark',
  'packages/ui/src/bot-brand-logo.tsx',
  'apps/desktop/src/renderer/mcp-brand-marks.tsx',
  'apps/desktop/src/renderer/settings/provider-brand-marks.tsx',
];
const REQUIRED_ASSET_LICENSE_FILES = [
  'apps/desktop/node_modules/simple-icons/LICENSE.md',
  'apps/desktop/resources/licenses/renderer/ANT_DESIGN_ICONS_LICENSE.txt',
  'apps/desktop/resources/licenses/renderer/TDESIGN_ICONS_LICENSE.txt',
  'apps/desktop/resources/licenses/renderer/ALLOGO_LICENSE.txt',
  'apps/desktop/resources/licenses/renderer/SEMI_ICONS_LICENSE.txt',
];

const WORKSPACE_PREFIX = '@maka/';
const ALLOWED_LICENSES = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'Python-2.0',
  'Unlicense',
]);
const LICENSE_SELECTIONS = new Map([
  ['(AFL-2.1 OR BSD-3-Clause)', 'BSD-3-Clause'],
  ['(MPL-2.0 OR Apache-2.0)', 'Apache-2.0'],
]);
const LICENSE_METADATA_OVERRIDES = new Map([
  ['khroma@2.1.0', 'MIT'],
  // Declares the ambiguous legacy "BSD"; the shipped LICENSE is BSD-3-Clause.
  ['css-mediaquery@0.1.2', 'BSD-3-Clause'],
]);
const APACHE_TEXT_OVERRIDE_KEYS = new Set(['@ai-sdk/provider-utils@5.0.11']);
const MIT_COPYRIGHT_OVERRIDES = new Map([
  // The published tarball omits the repository LICENSE; sibling @astryxdesign
  // packages ship it verbatim with this notice.
  ['@astryxdesign/core@0.1.9', 'Copyright (c) 2026 Meta Platforms, Inc.'],
  ['@astryxdesign/core@0.2.0', 'Copyright (c) 2026 Meta Platforms, Inc.'],
  ['@stylexjs/stylex@0.19.0', 'Copyright (c) Meta Platforms, Inc. and affiliates.'],
  ['@wecom/aibot-node-sdk@1.0.7', 'Copyright (c) WeComTeam contributors'],
  [
    '@xterm/headless@6.0.0',
    [
      'Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)',
      'Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)',
      'Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)',
    ].join('\n'),
  ],
  ['agent-base@6.0.2', 'Copyright (c) 2013 Nathan Rajlich <nathan@tootallnate.net>'],
  ['https-proxy-agent@5.0.1', 'Copyright (c) 2013 Nathan Rajlich <nathan@tootallnate.net>'],
  ['lazy-val@1.0.5', 'Copyright (c) Vladimir Krivosheev'],
  ['overlayscrollbars@2.16.0', 'Copyright (c) 2022 Rene Haas'],
]);

const MIT_TEXT = (copyrightNotice) => `MIT License

${copyrightNotice}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function normalizeText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

function collectDesktopClosure() {
  const tree = JSON.parse(
    execFileSync('npm', ['ls', '--workspace', '@maka/desktop', '--omit=dev', '--all', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
  const desktop = tree.dependencies?.['@maka/desktop'];
  if (!desktop) throw new Error('npm ls did not return the @maka/desktop workspace');

  const packages = new Map();
  const visit = (dependencies) => {
    for (const [name, dependency] of Object.entries(dependencies ?? {})) {
      if (!dependency || typeof dependency !== 'object') continue;
      if (!name.startsWith(WORKSPACE_PREFIX) && typeof dependency.version === 'string') {
        packages.set(`${name}@${dependency.version}`, {
          name,
          version: dependency.version,
        });
      }
      visit(dependency.dependencies);
    }
  };
  visit(desktop.dependencies);
  return [...packages.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
  );
}

function packageNameFromLockPath(lockPath) {
  const marker = 'node_modules/';
  const index = lockPath.lastIndexOf(marker);
  return index < 0 ? undefined : lockPath.slice(index + marker.length);
}

function buildLockIndex() {
  const lock = readJson(join(repoRoot, 'package-lock.json'));
  const index = new Map();
  for (const [lockPath, metadata] of Object.entries(lock.packages ?? {})) {
    if (!metadata?.version) continue;
    const name = packageNameFromLockPath(lockPath);
    if (!name) continue;
    const key = `${name}@${metadata.version}`;
    const entries = index.get(key) ?? [];
    entries.push({ lockPath, metadata });
    index.set(key, entries);
  }
  return index;
}

function packageDirectory(packageKey, candidates) {
  for (const candidate of candidates ?? []) {
    const directory = join(repoRoot, candidate.lockPath);
    if (!existsSync(join(directory, 'package.json'))) continue;
    const manifest = readJson(join(directory, 'package.json'));
    if (`${manifest.name}@${manifest.version}` === packageKey) return directory;
  }
  throw new Error(`${packageKey}: package-lock entry does not resolve to an installed package`);
}

function normalizeRepository(repository) {
  if (typeof repository === 'string') return repository;
  if (repository && typeof repository.url === 'string') {
    return repository.directory ? `${repository.url}#${repository.directory}` : repository.url;
  }
  return undefined;
}

function readLicenseFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && /^(licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(entry.name),
    )
    .map((entry) => ({
      name: entry.name,
      text: normalizeText(readFileSync(join(directory, entry.name), 'utf8')),
    }))
    .filter((entry) => entry.text.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function overrideLicenseText(packageKey, selectedLicense) {
  if (selectedLicense === 'Apache-2.0' && APACHE_TEXT_OVERRIDE_KEYS.has(packageKey)) {
    return normalizeText(readFileSync(join(repoRoot, 'LICENSE'), 'utf8'));
  }
  const copyrightNotice = MIT_COPYRIGHT_OVERRIDES.get(packageKey);
  if (selectedLicense === 'MIT' && copyrightNotice) return MIT_TEXT(copyrightNotice);
  return undefined;
}

function renderNotice() {
  const lockIndex = buildLockIndex();
  const sections = [];
  for (const dependency of collectDesktopClosure()) {
    const packageKey = `${dependency.name}@${dependency.version}`;
    const candidates = lockIndex.get(packageKey);
    if (!candidates?.length) throw new Error(`${packageKey}: missing from package-lock.json`);
    const directory = packageDirectory(packageKey, candidates);
    const manifest = readJson(join(directory, 'package.json'));
    // Overrides go first: they also correct a PRESENT-but-wrong declaration
    // (css-mediaquery ships the ambiguous legacy "BSD"), not only a missing one.
    const declaredLicense =
      LICENSE_METADATA_OVERRIDES.get(packageKey) ??
      manifest.license ??
      candidates.find((candidate) => candidate.metadata.license)?.metadata.license;
    if (typeof declaredLicense !== 'string' || declaredLicense.trim().length === 0) {
      throw new Error(`${packageKey}: missing SPDX license metadata`);
    }
    const selectedLicense = LICENSE_SELECTIONS.get(declaredLicense) ?? declaredLicense;
    if (!ALLOWED_LICENSES.has(selectedLicense)) {
      throw new Error(
        `${packageKey}: license ${declaredLicense} does not resolve to an approved license`,
      );
    }

    let licenseFiles = readLicenseFiles(directory);
    if (licenseFiles.length === 0) {
      const text = overrideLicenseText(packageKey, selectedLicense);
      if (!text) {
        throw new Error(
          `${packageKey}: no LICENSE/COPYING/NOTICE file and no exact-version override`,
        );
      }
      licenseFiles = [{ name: 'VERSION-PINNED LICENSE TEXT OVERRIDE', text }];
    }

    const repository = normalizeRepository(manifest.repository);
    const metadata = [
      `Package: ${packageKey}`,
      `Declared license: ${declaredLicense}`,
      `Selected license: ${selectedLicense}`,
      ...(repository ? [`Repository: ${repository}`] : []),
    ];
    const texts = licenseFiles.map(({ name, text }) => `--- ${name} ---\n${text}`);
    sections.push(`${metadata.join('\n')}\n\n${texts.join('\n\n')}`);
  }

  return `Maka Desktop — Production npm Third-Party Notices
====================================================

Generated by scripts/generate-third-party-notices.mjs from the exact
@maka/desktop production dependency closure and package-lock.json.
Do not edit this file by hand.

Policy: every package must resolve to an ASF-compatible SPDX license. Compound
expressions record the compatible selected license. Packages without a shipped
license file require an exact name@version text override in the generator.

${sections.join('\n\n================================================================================\n\n')}
`;
}

function validateAssetNotices() {
  const notice = readFileSync(assetNoticePath, 'utf8');
  for (const marker of REQUIRED_ASSET_NOTICE_MARKERS) {
    if (!notice.includes(marker)) {
      throw new Error(`Asset notice is incomplete: missing ${JSON.stringify(marker)}`);
    }
  }
  for (const relativePath of REQUIRED_ASSET_LICENSE_FILES) {
    const path = join(repoRoot, relativePath);
    if (!existsSync(path) || readFileSync(path, 'utf8').trim().length === 0) {
      throw new Error(`Asset license file is missing or empty: ${relativePath}`);
    }
  }
}

validateAssetNotices();
const generated = renderNotice();
if (checkOnly) {
  if (!existsSync(outputPath) || readFileSync(outputPath, 'utf8') !== generated) {
    throw new Error(
      'Production dependency notices are stale. Run npm run generate:third-party-notices.',
    );
  }
  console.log('[third-party-notices] OK — production dependency inventory is current.');
} else {
  mkdirSync(resolve(outputPath, '..'), { recursive: true });
  writeFileSync(outputPath, generated, 'utf8');
  console.log(`[third-party-notices] wrote ${outputPath}`);
}
