import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { npmSpawnOptions } from './npm-spawn.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const checkOnly = process.argv.includes('--check');
const targetName = (() => {
  const index = process.argv.indexOf('--target');
  if (index < 0) return 'desktop';
  const value = process.argv[index + 1];
  if (!value) throw new Error('--target requires desktop or cli');
  return value;
})();
const TARGETS = {
  desktop: {
    workspaceName: '@maka/desktop',
    title: 'Maka Desktop — Production npm Third-Party Notices',
    underline: '====================================================',
    outputPath: join(repoRoot, 'apps/desktop/resources/licenses/npm/THIRD_PARTY_NOTICES.txt'),
    validateAssets: true,
  },
  cli: {
    workspaceName: 'maka-agent',
    title: 'Maka CLI — Production npm Third-Party Notices',
    underline: '=============================================',
    outputPath: join(repoRoot, 'packages/cli/THIRD_PARTY_NOTICES.txt'),
    validateAssets: false,
  },
};
const target = TARGETS[targetName];
if (!target) throw new Error(`Unsupported notice target: ${targetName}`);
const { outputPath } = target;
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
  // Vendored from the installed simple-icons tarball (CC0-1.0); the package
  // hoists to different node_modules depths across majors, so the notice
  // generator and the packager read the static copy instead.
  'apps/desktop/resources/licenses/renderer/SIMPLE_ICONS_LICENSE.md',
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
// The published tarball omits the repository LICENSE; package.json declares Apache-2.0.
// Keyed by exact version so a bump re-checks the license rather than inheriting this.
const APACHE_TEXT_OVERRIDE_KEYS = new Set(['@ai-sdk/provider-utils@5.0.27']);
const EMBEDDED_COMPONENT_LICENSES = new Map([
  [
    '@ai-sdk/code-mode',
    {
      version: '1.0.23',
      components: [
        {
          name: 'quickjs-emscripten (embedded runtime)',
          repository: 'https://github.com/justjake/quickjs-emscripten',
          copyright: 'quickjs-emscripten copyright (c) 2019-2024 Jake Teton-Landis',
        },
        {
          name: 'QuickJS JavaScript engine (embedded runtime)',
          repository: 'https://github.com/bellard/quickjs',
          copyright: [
            'Copyright (c) 2017-2021 Fabrice Bellard',
            'Copyright (c) 2017-2021 Charlie Gordon',
          ].join('\n'),
        },
      ],
    },
  ],
]);
const MIT_COPYRIGHT_OVERRIDES = new Map([
  // The published tarball omits the monorepo-root LICENSE.
  ['@earendil-works/pi-tui@0.83.0', 'Copyright (c) 2025 Mario Zechner'],
  // The published tarball omits the repository LICENSE; sibling @astryxdesign
  // packages ship it verbatim with this notice.
  ['@astryxdesign/core@0.1.9', 'Copyright (c) 2026 Meta Platforms, Inc.'],
  ['@astryxdesign/core@0.2.0', 'Copyright (c) 2026 Meta Platforms, Inc.'],
  ['@astryxdesign/core@0.3.0', 'Copyright (c) 2026 Meta Platforms, Inc.'],
  ['@astryxdesign/core@0.4.0', 'Copyright (c) 2026 Meta Platforms, Inc.'],
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
  // Published from TooTallNate/proxy-agents, which keeps its LICENSE at the
  // repo root; the per-package tarball ships no license file.
  ['proxy-agent-negotiate@1.1.0', 'Copyright (c) 2013 Nathan Rajlich <nathan@tootallnate.net>'],
  ['lazy-val@1.0.5', 'Copyright (c) Vladimir Krivosheev'],
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

function collectWorkspaceClosure(workspaceName) {
  const tree = JSON.parse(
    execFileSync(
      'npm',
      ['ls', '--workspace', workspaceName, '--omit=dev', '--all', '--json'],
      npmSpawnOptions({
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      }),
    ),
  );
  const workspace = tree.dependencies?.[workspaceName];
  if (!workspace) throw new Error(`npm ls did not return the ${workspaceName} workspace`);

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
  visit(workspace.dependencies);
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
  const dependencies = collectWorkspaceClosure(target.workspaceName);
  for (const dependency of dependencies) {
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
  for (const [packageName, inventory] of EMBEDDED_COMPONENT_LICENSES) {
    const matchingDependencies = dependencies.filter((candidate) => candidate.name === packageName);
    for (const dependency of matchingDependencies) {
      const owner = `${dependency.name}@${dependency.version}`;
      if (dependency.version !== inventory.version) {
        throw new Error(`${owner}: embedded component licenses require exact-version review`);
      }
      for (const component of inventory.components) {
        sections.push(
          [
            `Embedded component: ${component.name}`,
            `Embedded by: ${owner}`,
            'Selected license: MIT',
            `Repository: ${component.repository}`,
            '',
            '--- VERSION-PINNED EMBEDDED LICENSE TEXT ---',
            MIT_TEXT(component.copyright),
          ].join('\n'),
        );
      }
    }
  }

  return `${target.title}
${target.underline}

Generated by scripts/generate-third-party-notices.mjs from the exact
${target.workspaceName} production dependency closure and package-lock.json.
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

/**
 * Say what drifted, not just that something did.
 *
 * The comparison is byte-exact over a 15k-line generated file, so "stale" on
 * its own leaves whoever hit it — often on a CI runner whose OS they are not
 * holding — with nothing to act on. The two shapes worth separating are a
 * changed dependency closure, which the suggested command fixes, and identical
 * packages whose license bytes moved, which usually means something upstream
 * or environmental rather than a missed regeneration.
 */
function describeNoticeDrift(committed, generated) {
  // Split on either ending. A CRLF checkout would otherwise leave `\r` on every
  // extracted name, reporting the same packages as both added and removed and
  // hiding the text-drift branch below — the diagnostic would misdescribe
  // exactly the environment-specific failure it exists to explain.
  const linesOf = (text) => text.split(/\r?\n/);
  const packagesIn = (text) =>
    new Set(
      linesOf(text)
        .filter((line) => line.startsWith('Package: '))
        .map((line) => line.slice('Package: '.length).trim()),
    );
  const committedPackages = packagesIn(committed);
  const generatedPackages = packagesIn(generated);
  const onlyGenerated = [...generatedPackages].filter((name) => !committedPackages.has(name));
  const onlyCommitted = [...committedPackages].filter((name) => !generatedPackages.has(name));

  const lines = [];
  const list = (label, names) => {
    if (names.length === 0) return;
    const shown = names.slice(0, 10);
    lines.push(`  ${label} (${names.length}):`);
    for (const name of shown) lines.push(`    ${name}`);
    if (names.length > shown.length) lines.push(`    …and ${names.length - shown.length} more`);
  };
  list('present in the closure but missing from the committed file', onlyGenerated);
  list('committed but no longer in the closure', onlyCommitted);

  if (onlyGenerated.length === 0 && onlyCommitted.length === 0) {
    const committedLines = linesOf(committed);
    const generatedLines = linesOf(generated);
    const limit = Math.max(committedLines.length, generatedLines.length);
    let index = 0;
    while (index < limit && committedLines[index] === generatedLines[index]) index += 1;
    lines.push('  the same packages are listed, so the difference is in the notice text itself');
    if (index === limit) {
      // Every line matches once endings are normalized, so the bytes differ only
      // in how the lines end. Naming that is the whole answer — regenerating
      // will not help, and the repository already forces LF through
      // .gitattributes, so a CRLF checkout means that rule did not take effect.
      lines.push('  every line matches once line endings are normalized:');
      lines.push(`    committed uses CRLF: ${committed.includes('\r\n')}`);
      lines.push(`    generated uses CRLF: ${generated.includes('\r\n')}`);
      lines.push('  check .gitattributes and the checkout, not the dependency closure');
    } else {
      lines.push(`  first difference at line ${index + 1}:`);
      lines.push(`    committed:  ${JSON.stringify(committedLines[index] ?? '<end of file>')}`);
      lines.push(`    generated:  ${JSON.stringify(generatedLines[index] ?? '<end of file>')}`);
    }
  }
  return lines.join('\n');
}

if (target.validateAssets) validateAssetNotices();
const generated = renderNotice();
if (checkOnly) {
  if (!existsSync(outputPath)) {
    throw new Error(
      `Production dependency notices are missing at ${outputPath}. Run npm run generate:third-party-notices.`,
    );
  }
  const committed = readFileSync(outputPath, 'utf8');
  if (committed !== generated) {
    throw new Error(
      `Production dependency notices are stale. Run npm run generate:third-party-notices.\n${describeNoticeDrift(committed, generated)}`,
    );
  }
  console.log('[third-party-notices] OK — production dependency inventory is current.');
} else {
  mkdirSync(resolve(outputPath, '..'), { recursive: true });
  writeFileSync(outputPath, generated, 'utf8');
  console.log(`[third-party-notices] wrote ${outputPath}`);
}
