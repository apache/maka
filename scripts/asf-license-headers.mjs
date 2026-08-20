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

/**
 * ASF source-header audit.
 *
 * The audit asserts two properties of the tree it is pointed at, and nothing
 * else:
 *
 *   1. Every entry is classified exactly once — covered, excluded with a
 *      recorded reason, or an audit failure. Nothing is dropped from the tree
 *      under audit; the enumeration only decides which tree that is.
 *   2. In every covered file the ASF license text occurs exactly once, and
 *      that occurrence is the canonical rendering at the top of the file.
 *
 * Both are properties of the artifact, stated without reference to what
 * `write` produces. That separation is the point: an audit defined as "starts
 * with the bytes this module emits" can only confirm its own writer, and will
 * accept a second header stacked on top of a first one it failed to recognize.
 *
 * So detection is deliberately loose and acceptance deliberately strict.
 * `countLicenseText` finds the license text through any comment syntax,
 * indentation, or line wrapping; only the exact canonical rendering is
 * accepted. `write` is correspondingly dumb — it inserts a header where there
 * is none and refuses every other state, because every other state is a
 * decision a person has to make.
 *
 * See `.github/ASF_SOURCE_HEADERS.md` for the policy this file implements.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRepoRoot = resolve(import.meta.dirname, '..');
const maxCommandBuffer = 64 * 1024 * 1024;

/**
 * The header from https://www.apache.org/legal/src-headers.html, verbatim.
 * An empty string renders as a comment line with no trailing whitespace.
 */
export const licenseLines = [
  'Licensed to the Apache Software Foundation (ASF) under one',
  'or more contributor license agreements.  See the NOTICE file',
  'distributed with this work for additional information',
  'regarding copyright ownership.  The ASF licenses this file',
  'to you under the Apache License, Version 2.0 (the',
  '"License"); you may not use this file except in compliance',
  'with the License.  You may obtain a copy of the License at',
  '',
  '    http://www.apache.org/licenses/LICENSE-2.0',
  '',
  'Unless required by applicable law or agreed to in writing,',
  'software distributed under the License is distributed on an',
  '"AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY',
  'KIND, either express or implied.  See the License for the',
  'specific language governing permissions and limitations',
  'under the License.',
];

/**
 * Comment syntaxes the header is rendered into. `prefixPattern` matches the
 * lines that must stay first in the file — an interpreter shebang or an HTML
 * doctype — so the header goes directly below them instead of breaking them.
 */
const commentStyles = {
  block: { open: '/*', line: ' *', close: ' */', prefixPattern: /^#![^\n]*\n/ },
  slash: { linePrefix: '//' },
  hash: { linePrefix: '#', prefixPattern: /^#![^\n]*\n/ },
  // A doctype must open an HTML file, and YAML front matter must open a
  // Markdown file, so the header follows either one.
  html: {
    open: '<!--',
    line: ' ',
    close: '-->',
    prefixPattern: /^(?:<!doctype html>\n|---\n[\s\S]*?\n---\n)/i,
  },
};

/**
 * File extensions covered by the header policy, and the comment syntax used
 * for each. A covered file must carry the header; nothing else may.
 */
const coveredExtensions = new Map([
  ['.cjs', 'block'],
  ['.css', 'block'],
  ['.html', 'html'],
  ['.js', 'block'],
  ['.jsonc', 'slash'],
  ['.md', 'html'],
  ['.mjs', 'block'],
  ['.mts', 'block'],
  ['.nsh', 'hash'],
  ['.ps1', 'hash'],
  ['.py', 'hash'],
  ['.rs', 'block'],
  ['.sh', 'hash'],
  ['.swift', 'block'],
  ['.toml', 'hash'],
  ['.ts', 'block'],
  ['.tsx', 'block'],
  ['.yaml', 'hash'],
  ['.yml', 'hash'],
]);

/** Covered files whose name carries no extension. */
const coveredNames = new Map([
  ['Dockerfile', 'hash'],
  // A POSIX shell script that the Eval egress sidecar invokes by name.
  ['network-policy', 'hash'],
]);

const startsWith = (prefix) => (path) => path === prefix || path.startsWith(`${prefix}/`);
const hasExtension =
  (...extensions) =>
  (path) =>
    extensions.some((extension) => path.endsWith(extension));
const isOneOf = (...paths) => {
  const set = new Set(paths);
  return (path) => set.has(path);
};
const isNamed = (...names) => {
  const set = new Set(names);
  return (path) => set.has(basename(path));
};
const isUnder =
  (prefix, ...extensions) =>
  (path) =>
    startsWith(prefix)(path) && hasExtension(...extensions)(path);

/**
 * The reviewed exclusion list. Order matters only for reporting: a file is
 * attributed to the first rule that matches it.
 *
 * A rule either names the files it excludes or states a structural property
 * that holds for anything it matches. A bare directory prefix does neither: it
 * silently lends its justification to whatever is added to that directory
 * next, which is the failure this audit exists to prevent.
 *
 * There is deliberately no rule for paths `.gitattributes` keeps out of the
 * archive. Restating that here would put the same fact in two places and let
 * the copy answer for the original — an extracted candidate that somehow
 * contained such a path would be excused by the very reason that says it
 * cannot be there. `listCheckoutFiles` asks Git instead.
 */
export const exclusionRules = [
  {
    id: 'asf-release-documents',
    justification:
      'These files are the license, notice, and incubation disclosure themselves. ASF policy fixes their contents, so a header inside them would be circular.',
    matches: isOneOf('DISCLAIMER-WIP', 'LICENSE', 'NOTICE'),
  },
  {
    id: 'third-party-license-texts',
    justification:
      'Third-party license and notice texts redistributed with the product. An ASF header on any of them would assert ASF provenance over content ASF does not own. The upstream texts additionally have to stay byte-identical to what their projects published, and the aggregated notices are generator output that a hand-written header would not survive.',
    matches: isOneOf(
      'apps/desktop/resources/licenses/cargo/THIRD_PARTY_NOTICES.txt',
      'apps/desktop/resources/licenses/npm/THIRD_PARTY_NOTICES.txt',
      'apps/desktop/resources/licenses/renderer/ALLOGO_LICENSE.txt',
      'apps/desktop/resources/licenses/renderer/ANT_DESIGN_ICONS_LICENSE.txt',
      'apps/desktop/resources/licenses/renderer/SEMI_ICONS_LICENSE.txt',
      'apps/desktop/resources/licenses/renderer/SIMPLE_ICONS_LICENSE.md',
      'apps/desktop/resources/licenses/renderer/TDESIGN_ICONS_LICENSE.txt',
      'apps/desktop/src/renderer/public/THIRD_PARTY_LICENSES.txt',
      'packages/cli/THIRD_PARTY_NOTICES.txt',
    ),
  },
  {
    id: 'third-party-source',
    justification:
      'Work of third parties kept under its own license, including files Maka adapted from an upstream project and therefore does not wholly own. ASF policy treats the non-Maka portion of a mixed-origin file as third-party work, so Maka may not assert a whole-file ASF header over one; whether a heavily modified file should instead carry a combined header is a PPMC decision, not a mechanical sweep. Their attribution belongs to LICENSE and the NOTICE audit, not to this gate.',
    matches: (path) =>
      isOneOf(
        'experiments/windows-sandbox/launcher/Cargo.lock',
        // Adapted from opencode under MIT; attribution pinned by #3325.
        'packages/runtime/src/edit-replace.ts',
        'packages/runtime/src/tool-output.ts',
        // Adapted from Vercel AI SDK material; recorded by the #2907 origin audit.
        'packages/runtime/src/model-protocol.ts',
        'packages/ui/src/astryx-chat-reasoning.tsx',
      )(path) ||
      isUnder('apps/desktop/src/renderer/assets/provider-brands', '.svg')(path) ||
      isUnder('patches', '.patch')(path),
  },
  {
    id: 'generated-files',
    justification:
      'Mechanically derived from a generator in this repository. A hand-written header would be reverted by the next regeneration; the generators themselves carry the header.',
    matches: isOneOf(
      'apps/desktop/src/renderer/astryx-theme/maka.css',
      'apps/desktop/src/renderer/astryx-theme/maka.d.ts',
      'apps/desktop/src/renderer/astryx-theme/maka.js',
      'docs/astryx-surface-file-inventory.md',
      'docs/astryx-surface-file-inventory.paths',
      'docs/windows-test-inventory.md',
      'packages/core/src/model-metadata.generated.ts',
      'packages/runtime/src/bundled-skill-catalog.generated.ts',
      'packages/runtime/src/telemetry/model-pricing.generated.ts',
    ),
  },
  {
    id: 'verbatim-runtime-payloads',
    justification:
      'Bundled skill payloads are embedded in the generated catalog verbatim, pinned there by content digest, and delivered to the model as instructions. A header would be republished as agent prompt text and would invalidate the recorded digests. Each payload is listed, so a new bundled skill is reviewed rather than inheriting this reason from its directory.',
    matches: isOneOf('packages/runtime/resources/bundled-skills/computer-use/SKILL.md'),
  },
  {
    id: 'verbatim-github-templates',
    justification:
      'GitHub copies this file into every new pull request description. A header here would be republished into unrelated prose instead of licensing a source file.',
    matches: isOneOf('.github/pull_request_template.md'),
  },
  {
    id: 'byte-significant-fixtures',
    justification:
      'Recorded inputs and captured historical state. Tests assert on their exact bytes or parse them with a strict reader, and their value is that they reproduce what a real system produced rather than that they are authored source.',
    matches: (path) =>
      isOneOf(
        'packages/storage/src/__tests__/fixtures/codex-rollout-v0.144.jsonl',
        'packages/storage/test-fixtures/v0.1.6-operational-state/runtime.sqlite',
        'packages/storage/test-fixtures/workflow-schema-v8.sql',
      )(path) || isUnder('docs/eval', '.csv')(path),
  },
  {
    id: 'no-comment-syntax',
    justification:
      'The format has no comment syntax, so a header could only be added by corrupting the file for its parser.',
    matches: hasExtension('.csv', '.json', '.jsonl', '.paths'),
  },
  {
    id: 'binary-files',
    justification:
      'Binary image and database content. There is no text position in these formats where a header could be added without corrupting the file.',
    matches: hasExtension('.png', '.sqlite'),
  },
  {
    id: 'no-creative-content',
    justification:
      'Version-control metadata and platform manifests whose content is a list of names or required platform keys. Apache RAT excludes the same kind of file by default.',
    matches: (path) =>
      isNamed('.gitignore')(path) ||
      isOneOf(
        '.git-blame-ignore-revs',
        '.gitattributes',
        '.mailmap',
        'apps/desktop/build/entitlements.mac.inherit.plist',
        'apps/desktop/build/entitlements.mac.plist',
      )(path),
  },
];

/**
 * In-band claims that a file carries someone else's work. This gate cannot
 * determine provenance — that is a fact about people, not a property of a path
 * — but it can refuse to let an unreviewed claim through. A covered file that
 * announces a foreign origin must appear in `reviewedProvenance` with the
 * decision that nonetheless put an ASF header on it.
 *
 * The markers are deliberately narrow. Measured over the whole tree, an SPDX
 * identifier, an explicit copyright line, and `Adapted from` hit three files
 * between them; `derived from` hits seventy, and an upstream project name like
 * `opencode` hits forty-five because Maka supports it as a provider. A net
 * that noisy gets answered with a list of paths added to quiet it, which is
 * the failure this rule exists to avoid.
 *
 * This is a net, not a proof. It catches a file that states its origin; it
 * cannot catch prose that merely alludes to one, and `edit-replace.ts` — which
 * says it "matches opencode's replacers" — is invisible to it.
 */
const provenanceMarkers = [
  /\bSPDX-License-Identifier\b/,
  /\bCopyright\s+(?:\(c\)|©|\d{4})/i,
  /\bAdapted from\b/i,
];

/**
 * Covered files whose provenance markers have been reviewed, with the reason
 * they may carry the ASF header anyway.
 */
const reviewedProvenance = new Map([
  [
    '.github/ASF_SOURCE_HEADERS.md',
    'Documents the marker patterns; the match is the policy describing its own rule.',
  ],
  [
    'docs/code-origin-audit.md',
    'Maka-authored audit report whose subject is other projects’ licensing. The copyright lines it quotes are its findings, not a claim over the file.',
  ],
  [
    'scripts/asf-license-headers.mjs',
    'Defines the marker patterns; the match is this module quoting its own rule.',
  ],
  [
    'scripts/asf-license-headers.test.mjs',
    'Synthetic fixtures written to exercise the provenance markers.',
  ],
  [
    'scripts/generate-third-party-notices.mjs',
    'Maka-authored generator that emits upstream copyright lines into THIRD_PARTY_NOTICES.txt. The copyright it names is its output, not its own.',
  ],
  [
    'scripts/sync-model-metadata.mjs',
    'Maka-authored generator that writes the models.dev attribution into the header of the catalog it generates. The copyright it names is its output, not its own.',
  ],
]);

/**
 * Covered files that carry the license text as data as well as in their own
 * header, so "exactly once" does not apply to them.
 */
const licenseTextAsData = new Map([
  [
    'scripts/asf-license-headers.mjs',
    'Defines `licenseLines`, the header text this policy renders.',
  ],
]);

export function renderHeader(styleName) {
  const style = commentStyles[styleName];
  if (!style) throw new Error(`Unknown comment style: ${styleName}`);
  if (style.linePrefix) {
    const body = licenseLines
      .map((text) => (text ? `${style.linePrefix} ${text}` : style.linePrefix))
      .join('\n');
    return `${body}\n`;
  }
  const body = licenseLines
    .map((text) => (text ? `${style.line} ${text}` : style.line.trimEnd()))
    .join('\n');
  return `${style.open}\n${body}\n${style.close}\n`;
}

export function commentStyleFor(path) {
  const name = basename(path);
  if (coveredNames.has(name)) return coveredNames.get(name);
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  return coveredExtensions.get(extension);
}

/**
 * Classification does not depend on which tree is being audited. A rule that
 * held in one and not the other would be a rule whose reason is really about
 * membership in the release, and membership is decided by the enumeration.
 */
export function classifyPath(path) {
  const rule = exclusionRules.find((candidate) => candidate.matches(path));
  if (rule) return { rule: rule.id, status: 'excluded' };
  const style = commentStyleFor(path);
  if (style) return { status: 'covered', style };
  return { status: 'unclassified' };
}

/**
 * Acceptance, strictly: the canonical rendering byte for byte, first in the
 * file apart from a shebang, a doctype, or Markdown front matter.
 */
export function findHeaderOffset(contents, styleName) {
  const style = commentStyles[styleName];
  const prefix = style.prefixPattern?.exec(contents)?.[0] ?? '';
  return contents.startsWith(renderHeader(styleName), prefix.length) ? prefix.length : -1;
}

export function hasHeader(contents, styleName) {
  return findHeaderOffset(contents, styleName) >= 0;
}

/** The opening line of the ASF header, which every rendering of it contains. */
const licenseMarker = licenseLines[0];

/**
 * Detection, loosely: comment punctuation and line wrapping flattened away, so
 * the license text is found whatever syntax it was written in — a `//` header,
 * a JSDoc block, `#`, an HTML comment, any indentation, an `https` variant of
 * the URL, or a rewrapped paragraph.
 */
export function countLicenseText(contents) {
  const flattened = contents.replace(/[*#/]/g, ' ').replace(/\s+/g, ' ');
  let count = 0;
  let index = flattened.indexOf(licenseMarker);
  while (index >= 0) {
    count += 1;
    index = flattened.indexOf(licenseMarker, index + licenseMarker.length);
  }
  return count;
}

/**
 * How a covered file stands against property 2. Only `absent` is safe for a
 * program to act on; every other state is one a person has to resolve.
 */
export function classifyHeader(contents, styleName, { textAsData = false } = {}) {
  const occurrences = countLicenseText(contents);
  if (occurrences === 0) return 'absent';
  if (occurrences > 1 && !textAsData) return 'duplicated';
  return hasHeader(contents, styleName) ? 'canonical' : 'unrecognized';
}

export class HeaderNotWritableError extends Error {
  constructor(status) {
    super(
      status === 'duplicated'
        ? 'the file already contains the ASF license text more than once; remove the extra copy by hand'
        : 'the file already carries the ASF license text in a form this policy does not render; reconcile it by hand',
    );
    this.name = 'HeaderNotWritableError';
    this.status = status;
  }
}

/**
 * Inserts the header, and only ever that. A file that already carries the
 * license text in some other shape is left alone and reported, because
 * rewriting it would mean deciding what someone else's rendering meant.
 */
export function applyHeader(contents, styleName, options) {
  const status = classifyHeader(contents, styleName, options);
  if (status === 'canonical') return contents;
  if (status !== 'absent') throw new HeaderNotWritableError(status);
  const style = commentStyles[styleName];
  const prefix = style.prefixPattern?.exec(contents)?.[0] ?? '';
  const rest = contents.slice(prefix.length);
  const separator = rest.trimStart() === '' ? '' : '\n';
  return `${prefix}${renderHeader(styleName)}${separator}${rest.replace(/^\n+/, '')}`;
}

/**
 * The paths `git archive` prunes from the source release, asked of Git rather
 * than restated here. `export-ignore` on a directory prunes the whole subtree,
 * but `git check-attr` reports one path at a time and does not inherit, so
 * every ancestor is queried too — `.claude` carries the attribute while
 * `.claude/launch.json` reports `unspecified`.
 */
function exportIgnoredPaths(root, paths) {
  const candidates = new Set();
  for (const path of paths) {
    const segments = path.split('/');
    for (let index = 1; index <= segments.length; index += 1) {
      candidates.add(segments.slice(0, index).join('/'));
    }
  }
  const queried = [...candidates].sort();
  if (queried.length === 0) return new Set();
  const report = execFileSync('git', ['check-attr', '-z', '--stdin', 'export-ignore'], {
    cwd: root,
    encoding: 'utf8',
    input: `${queried.join('\0')}\0`,
    maxBuffer: maxCommandBuffer,
  }).split('\0');
  const ignored = new Set();
  // Each record is path, attribute, value.
  for (let index = 0; index + 2 < report.length; index += 3) {
    if (report[index + 2] === 'set') ignored.add(report[index]);
  }
  return ignored;
}

/**
 * The files a source release would carry: tracked files plus untracked files
 * Git would not ignore, minus what `export-ignore` prunes from the archive. A
 * new file is therefore audited before it is ever staged, while ignored local
 * scratch files stay out of the gate entirely.
 *
 * Subtracting here is not the enumeration excusing itself — it is what decides
 * which artifact the checkout stands in for. Nothing is subtracted from the
 * archive, where the artifact is already fixed.
 */
function listCheckoutFiles(root) {
  const names = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8', maxBuffer: maxCommandBuffer },
  )
    .split('\0')
    .filter(Boolean);
  const unique = [...new Set(names)].sort();
  const ignored = exportIgnoredPaths(root, unique);
  const released = unique.filter((path) =>
    path
      .split('/')
      .every((_, index, segments) => !ignored.has(segments.slice(0, index + 1).join('/'))),
  );
  return { files: released, irregular: [] };
}

/**
 * Every entry on disk, with nothing skipped by name. An extracted candidate
 * that contains a build directory is not a tree to audit around: the files in
 * it are unclassified and the gate says so. An entry that is neither a
 * directory nor a regular file is reported rather than passed over, because
 * silently dropping entries is how an audit comes to describe a smaller tree
 * than the one being released.
 */
function listArchiveFiles(root) {
  const files = [];
  const irregular = [];
  const walk = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : 1,
    );
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const path = relative(root, absolutePath).split(sep).join('/');
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (entry.isFile()) files.push(path);
      else irregular.push(path);
    }
  };
  walk(root);
  return { files, irregular };
}

/**
 * A checkout is audited through Git so that ignored local scratch files cannot
 * fail the gate. An extracted archive has no index, so every entry on disk is
 * audited.
 */
export function listSourceFiles(root) {
  if (existsSync(join(root, '.git'))) {
    return { ...listCheckoutFiles(root), mode: 'checkout' };
  }
  return { ...listArchiveFiles(root), mode: 'archive' };
}

export function auditSourceFiles({ files, irregular = [], mode }) {
  const excludedByRule = new Map();
  const unclassified = [];
  let covered = 0;

  for (const path of files) {
    const classification = classifyPath(path);
    if (classification.status === 'unclassified') {
      unclassified.push(path);
      continue;
    }
    if (classification.status === 'excluded') {
      const paths = excludedByRule.get(classification.rule) ?? [];
      paths.push(path);
      excludedByRule.set(classification.rule, paths);
      continue;
    }
    covered += 1;
  }

  const staleRules =
    mode === 'checkout'
      ? exclusionRules.filter((rule) => !excludedByRule.has(rule.id)).map((rule) => rule.id)
      : [];

  return {
    covered,
    duplicated: [],
    excludedByRule,
    irregular: [...irregular],
    missing: [],
    staleRules,
    unclassified,
    unrecognized: [],
    unreviewedProvenance: [],
  };
}

export function auditTree({ root = defaultRepoRoot } = {}) {
  const listing = listSourceFiles(root);
  const result = auditSourceFiles(listing);
  for (const path of listing.files) {
    const classification = classifyPath(path);
    if (classification.status !== 'covered') continue;
    const contents = readFileSync(join(root, path), 'utf8');
    const status = classifyHeader(contents, classification.style, {
      textAsData: licenseTextAsData.has(path),
    });
    if (status === 'absent') result.missing.push(path);
    else if (status === 'duplicated') result.duplicated.push(path);
    else if (status === 'unrecognized') result.unrecognized.push(path);
    if (
      !reviewedProvenance.has(path) &&
      provenanceMarkers.some((marker) => marker.test(contents))
    ) {
      result.unreviewedProvenance.push(path);
    }
  }
  return { ...result, mode: listing.mode, root };
}

export function writeHeaders({ root = defaultRepoRoot } = {}) {
  const { files } = listSourceFiles(root);
  const changed = [];
  for (const path of files) {
    const classification = classifyPath(path);
    if (classification.status !== 'covered') continue;
    const absolutePath = join(root, path);
    const contents = readFileSync(absolutePath, 'utf8');
    let updated;
    try {
      updated = applyHeader(contents, classification.style, {
        textAsData: licenseTextAsData.has(path),
      });
    } catch (error) {
      if (error instanceof HeaderNotWritableError) throw new Error(`${path}: ${error.message}`);
      throw error;
    }
    if (updated === contents) continue;
    writeFileSync(absolutePath, updated);
    changed.push(path);
  }
  return changed;
}

function reportExclusions(result) {
  console.log('Reviewed exclusions:');
  for (const rule of exclusionRules) {
    const paths = result.excludedByRule.get(rule.id) ?? [];
    console.log(`  ${rule.id}: ${paths.length} file(s)`);
    console.log(`    ${rule.justification}`);
    for (const path of paths) console.log(`      ${path}`);
  }
}

function runCheck({ report, root }) {
  const result = auditTree({ root });
  const excluded = [...result.excludedByRule.values()].reduce(
    (total, paths) => total + paths.length,
    0,
  );
  console.log(
    `Audited ${result.covered} covered and ${excluded} excluded file(s) in ${result.mode} mode at ${result.root}`,
  );
  if (report) reportExclusions(result);

  const failures = [
    [
      result.unclassified,
      'match no header rule and no reviewed exclusion. Cover the file type, or record an exclusion with its justification in scripts/asf-license-headers.mjs',
    ],
    [
      result.irregular,
      'are neither a directory nor a regular file. A source release carries files; remove them or classify what they are',
    ],
    [
      result.duplicated,
      'contain the ASF license text more than once. Remove the extra copy by hand',
    ],
    [
      result.unrecognized,
      'carry the ASF license text in a form this policy does not render. Reconcile each one by hand rather than adding a second header',
    ],
    [
      result.unreviewedProvenance,
      'claim a third-party origin — an SPDX identifier, a foreign copyright line, or an adaptation notice — while carrying an ASF header. Record the decision in `reviewedProvenance`, or exclude the file as third-party source',
    ],
    [result.missing, 'are missing the ASF license header. Run `npm run write:asf-headers`'],
  ];

  let failed = false;
  for (const [paths, explanation] of failures) {
    if (paths.length === 0) continue;
    failed = true;
    console.error(`\n${paths.length} file(s) ${explanation}:`);
    for (const path of paths) console.error(`  ${path}`);
  }
  if (result.staleRules.length > 0) {
    failed = true;
    console.error(
      `\n${result.staleRules.length} exclusion rule(s) match nothing and should be removed: ${result.staleRules.join(', ')}`,
    );
  }
  if (failed) process.exitCode = 1;
  else console.log('Every source file carries the ASF header or a reviewed exclusion.');
}

function parseCommandLine(arguments_) {
  const [command, ...tokens] = arguments_;
  let report = false;
  let root = defaultRepoRoot;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--report') {
      report = true;
      continue;
    }
    if (token === '--root') {
      const value = tokens[index + 1];
      if (!value || value.startsWith('--')) throw new Error('Missing value for --root');
      root = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unexpected argument: ${token}`);
  }
  return { command, report, root };
}

function main() {
  const { command, report, root } = parseCommandLine(process.argv.slice(2));
  if (!statSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`);
  if (command === 'check') {
    runCheck({ report, root });
    return;
  }
  if (command === 'write') {
    const changed = writeHeaders({ root });
    console.log(`Added the ASF header to ${changed.length} file(s)`);
    for (const path of changed) console.log(`  ${path}`);
    return;
  }
  throw new Error('Usage: asf-license-headers.mjs <check|write> [--root <dir>] [--report]');
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
