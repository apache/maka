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

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import {
  applyHeader,
  auditSourceFiles,
  auditTree,
  classifyHeader,
  classifyPath,
  commentStyleFor,
  countLicenseText,
  exclusionRules,
  hasHeader,
  HeaderNotWritableError,
  licenseLines,
  renderHeader,
} from './asf-license-headers.mjs';

const blockHeader = renderHeader('block');
const hashHeader = renderHeader('hash');

const temporaryRoots = [];
function fixtureTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'asf-headers-'));
  temporaryRoots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const absolutePath = join(root, path);
    mkdirSync(join(absolutePath, '..'), { recursive: true });
    writeFileSync(absolutePath, contents);
  }
  return root;
}

after(() => {
  for (const root of temporaryRoots) rmSync(root, { force: true, recursive: true });
});

describe('ASF header rendering', () => {
  test('renders the ASF text in each comment syntax', () => {
    assert.match(blockHeader, /^\/\*\n \* Licensed to the Apache Software Foundation \(ASF\)/);
    assert.match(
      blockHeader,
      / \*\n \*     http:\/\/www\.apache\.org\/licenses\/LICENSE-2\.0\n \*\n/,
    );
    assert.match(blockHeader, /\n \* under the License\.\n \*\/\n$/);
    assert.match(hashHeader, /^# Licensed to the Apache Software Foundation \(ASF\)/);
    assert.match(hashHeader, /\n#\n#     http:\/\/www\.apache\.org\/licenses\/LICENSE-2\.0\n/);
    assert.match(renderHeader('slash'), /^\/\/ Licensed to the Apache Software Foundation/);
    assert.match(renderHeader('html'), /^<!--\n {2}Licensed to the Apache Software Foundation/);
    assert.match(renderHeader('html'), /\n {2}under the License\.\n-->\n$/);
  });

  test('leaves no trailing whitespace on the blank comment lines', () => {
    for (const style of ['block', 'hash', 'slash', 'html']) {
      for (const line of renderHeader(style).split('\n')) {
        assert.equal(line, line.trimEnd(), `${style}: ${JSON.stringify(line)}`);
      }
    }
  });

  test('reproduces every line of the ASF header', () => {
    for (const line of licenseLines) {
      if (line) assert.ok(blockHeader.includes(line), line);
    }
  });
});

describe('ASF header application', () => {
  test('prepends the header and separates it from the body', () => {
    assert.equal(
      applyHeader("import 'node:fs';\n", 'block'),
      `${blockHeader}\nimport 'node:fs';\n`,
    );
  });

  test('is idempotent', () => {
    const once = applyHeader('const a = 1;\n', 'block');
    assert.equal(applyHeader(once, 'block'), once);
    assert.ok(hasHeader(once, 'block'));
  });

  test('keeps a shebang first', () => {
    const updated = applyHeader('#!/usr/bin/env node\nmain();\n', 'block');
    assert.equal(updated, `#!/usr/bin/env node\n${blockHeader}\nmain();\n`);
    assert.ok(hasHeader(updated, 'block'));
  });

  test('keeps an HTML doctype first', () => {
    const updated = applyHeader('<!doctype html>\n<html></html>\n', 'html');
    assert.equal(updated, `<!doctype html>\n${renderHeader('html')}\n<html></html>\n`);
    assert.ok(hasHeader(updated, 'html'));
  });

  test('keeps Markdown front matter first', () => {
    const source = '---\nname: skill\n---\n\n# Title\n';
    const updated = applyHeader(source, 'html');
    assert.equal(updated, `---\nname: skill\n---\n${renderHeader('html')}\n# Title\n`);
    assert.ok(hasHeader(updated, 'html'));
  });

  test('does not accept a header that is not at the top of the file', () => {
    assert.equal(hasHeader(`const a = 1;\n${blockHeader}`, 'block'), false);
  });

  test('handles an empty file without leaving a stray blank line', () => {
    assert.equal(applyHeader('', 'block'), blockHeader);
  });

  test('leaves an unrelated leading comment in place below the header', () => {
    assert.equal(
      applyHeader('# just a note\nkey: value\n', 'hash'),
      `${hashHeader}\n# just a note\nkey: value\n`,
    );
  });
});

/**
 * Detection has to be looser than acceptance. When one byte-exact test answered
 * both "does this file have a header?" and "is that header acceptable?", every
 * rendering the test did not recognize was treated as absent and given a second
 * license block — which the same byte-exact test then accepted, because the
 * block it had just written sat at the top of the file.
 */
describe('ASF header detection is looser than acceptance', () => {
  const variants = {
    'indented license URL': [hashHeader.replace('#     http', '#   http'), 'hash'],
    'https license URL': [blockHeader.replace('http://', 'https://'), 'block'],
    'slash comments in a block-comment file': [renderHeader('slash'), 'block'],
    'JSDoc block': [`/**\n${blockHeader.split('\n').slice(1).join('\n')}`, 'block'],
    'rewrapped prose': [`# ${licenseLines.filter(Boolean).join(' ')}\n`, 'hash'],
  };

  for (const [name, [variant, style]] of Object.entries(variants)) {
    test(`finds the license text written as ${name}`, () => {
      const source = `${variant}\nconst a = 1;\n`;
      assert.equal(countLicenseText(source), 1);
      assert.equal(classifyHeader(source, style), 'unrecognized');
    });

    test(`refuses to rewrite ${name} instead of stacking a second header`, () => {
      const source = `${variant}\nconst a = 1;\n`;
      assert.throws(() => applyHeader(source, style), HeaderNotWritableError);
    });
  }

  test('reports a file that already carries the license text twice', () => {
    const source = `${hashHeader}\n${hashHeader}\nkey: value\n`;
    assert.equal(countLicenseText(source), 2);
    assert.equal(classifyHeader(source, 'hash'), 'duplicated');
    assert.throws(() => applyHeader(source, 'hash'), HeaderNotWritableError);
  });

  test('allows a second occurrence only where the license text is data', () => {
    const source = `${hashHeader}\n# ${licenseLines[0]}\n`;
    assert.equal(classifyHeader(source, 'hash'), 'duplicated');
    assert.equal(classifyHeader(source, 'hash', { textAsData: true }), 'canonical');
  });

  test('does not see the license text in an unrelated comment', () => {
    assert.equal(countLicenseText('# just a note\nkey: value\n'), 0);
    assert.equal(classifyHeader('# just a note\nkey: value\n', 'hash'), 'absent');
  });

  test('never produces a file carrying the license text more than once', () => {
    const sources = [
      'const a = 1;\n',
      '#!/usr/bin/env node\nmain();\n',
      '',
      ...Object.values(variants).map(([variant]) => `${variant}\nconst a = 1;\n`),
    ];
    for (const source of sources) {
      let updated;
      try {
        updated = applyHeader(source, 'block');
      } catch (error) {
        assert.ok(error instanceof HeaderNotWritableError);
        continue;
      }
      assert.equal(countLicenseText(updated), 1, JSON.stringify(source.slice(0, 40)));
    }
  });
});

describe('ASF header classification', () => {
  test('covers product, script, and documentation source', () => {
    for (const path of [
      'packages/core/src/settings.ts',
      'apps/desktop/src/renderer/app-shell.tsx',
      'scripts/asf-source-release.mjs',
      'experiments/windows-sandbox/launcher/src/main.rs',
      'packages/eval/harbor/egress-proxy/Dockerfile',
      'packages/eval/harbor/egress-proxy/network-policy',
      '.github/workflows/ci.yml',
      'README.md',
    ]) {
      assert.equal(classifyPath(path).status, 'covered', path);
    }
  });

  test('excludes the reviewed categories', () => {
    const excluded = {
      LICENSE: 'asf-release-documents',
      'package.json': 'no-comment-syntax',
      'apps/desktop/assets/icon.png': 'binary-files',
      'patches/node-pty+1.2.0-beta.15.patch': 'third-party-source',
      'packages/ui/src/astryx-chat-reasoning.tsx': 'third-party-source',
      'packages/core/src/model-metadata.generated.ts': 'generated-files',
      'packages/runtime/resources/bundled-skills/computer-use/SKILL.md':
        'verbatim-runtime-payloads',
      '.github/pull_request_template.md': 'verbatim-github-templates',
      'packages/storage/test-fixtures/workflow-schema-v8.sql': 'byte-significant-fixtures',
      '.gitattributes': 'no-creative-content',
      'apps/desktop/.gitignore': 'no-creative-content',
    };
    for (const [path, rule] of Object.entries(excluded)) {
      assert.deepEqual(classifyPath(path), { rule, status: 'excluded' }, path);
    }
  });

  test('excludes the mixed-origin files Maka adapted from upstream projects', () => {
    for (const path of [
      'packages/runtime/src/edit-replace.ts',
      'packages/runtime/src/model-protocol.ts',
      'packages/runtime/src/tool-output.ts',
    ]) {
      assert.deepEqual(
        classifyPath(path),
        { rule: 'third-party-source', status: 'excluded' },
        path,
      );
    }
  });

  test('keeps Maka-authored files out of the third-party and fixture rules', () => {
    assert.equal(classifyPath('patches/README.md').status, 'covered');
    assert.equal(
      classifyPath('docs/eval/terminal-bench-2.1-maka-vs-kimi-code-v11.md').status,
      'covered',
    );
  });

  /**
   * A directory prefix would lend its justification to whatever lands in that
   * directory next. Each of these rules names its files or states a structural
   * property, so a new file of a different kind stays unclassified.
   */
  test('does not extend a reviewed exclusion to a directory', () => {
    for (const path of [
      'apps/desktop/resources/licenses/renderer/helper.ts',
      'apps/desktop/src/renderer/assets/provider-brands/README.md',
      'packages/runtime/resources/bundled-skills/new-skill/SKILL.md',
      'packages/runtime/resources/bundled-skills/README.md',
    ]) {
      assert.notEqual(classifyPath(path).status, 'excluded', path);
    }
  });

  test('leaves an unknown file type unclassified so the audit fails closed', () => {
    assert.equal(classifyPath('vendor/thing.kt').status, 'unclassified');
    assert.equal(commentStyleFor('vendor/thing.kt'), undefined);
  });

  test('gives every exclusion rule a unique id and a justification', () => {
    const ids = new Set();
    for (const rule of exclusionRules) {
      assert.equal(ids.has(rule.id), false, rule.id);
      ids.add(rule.id);
      assert.ok(rule.justification.length > 60, rule.id);
      assert.equal(typeof rule.matches, 'function', rule.id);
    }
  });

  /**
   * `.gitattributes` decides what leaves the archive. A rule restating that
   * here would excuse such a path when an extracted candidate contained it —
   * using the reason as cover for the one thing it says cannot happen.
   */
  test('records no exclusion for paths that export-ignore prunes', () => {
    assert.equal(classifyPath('.claude/launch.json').status, 'excluded');
    assert.equal(classifyPath('.claude/launch.json').rule, 'no-comment-syntax');
    assert.equal(classifyPath('.claude/skills/local/SKILL.md').status, 'covered');
    assert.equal(classifyPath('maka-proposal-zh-review.txt').status, 'unclassified');
  });
});

describe('ASF header audit', () => {
  test('reports unclassified files separately from missing headers', () => {
    const result = auditSourceFiles({
      files: ['LICENSE', 'packages/core/src/settings.ts', 'vendor/thing.kt'],
      mode: 'archive',
    });
    assert.deepEqual(result.unclassified, ['vendor/thing.kt']);
    assert.equal(result.covered, 1);
    assert.deepEqual(result.excludedByRule.get('asf-release-documents'), ['LICENSE']);
  });

  test('reports an exclusion rule that matches nothing in a checkout', () => {
    const result = auditSourceFiles({ files: ['LICENSE'], mode: 'checkout' });
    assert.equal(result.staleRules.includes('asf-release-documents'), false);
    assert.ok(result.staleRules.includes('binary-files'));
  });

  test('does not call an archive-absent rule stale', () => {
    const result = auditSourceFiles({ files: ['LICENSE'], mode: 'archive' });
    assert.deepEqual(result.staleRules, []);
  });
});

/**
 * The audit walks an extracted candidate, where there is no Git index to ask.
 * Skipping entries by directory name once let a file inside `dist/` or
 * `release/` reach a release candidate completely unaudited while the gate
 * still reported success.
 */
describe('ASF header audit over an extracted candidate', () => {
  test('classifies every entry, including one inside a build directory', () => {
    const root = fixtureTree({
      'README.md': renderHeader('html'),
      'dist/unexpected.kt': 'fun main() {}\n',
      'release/unexpected.kt': 'fun main() {}\n',
    });
    const result = auditTree({ root });
    assert.equal(result.mode, 'archive');
    assert.deepEqual(result.unclassified.sort(), ['dist/unexpected.kt', 'release/unexpected.kt']);
  });

  /**
   * These paths are absent from a correct archive because `export-ignore`
   * prunes them. Finding one means it did not, which the audit has to report
   * rather than excuse.
   */
  test('does not excuse a path that export-ignore should have pruned', () => {
    const root = fixtureTree({
      'README.md': renderHeader('html'),
      '.claude/skills/local/SKILL.md': '# Local\n',
      'maka-proposal-zh-review.txt': 'notes\n',
    });
    const result = auditTree({ root });
    assert.deepEqual(result.unclassified, ['maka-proposal-zh-review.txt']);
    assert.deepEqual(result.missing, ['.claude/skills/local/SKILL.md']);
  });

  test('reports an entry that is not a regular file', () => {
    const root = fixtureTree({ 'README.md': renderHeader('html') });
    symlinkSync('README.md', join(root, 'LINK.md'));
    assert.deepEqual(auditTree({ root }).irregular, ['LINK.md']);
  });

  test('reports a covered file that is missing the header', () => {
    const root = fixtureTree({ 'notes.md': '# Notes\n' });
    assert.deepEqual(auditTree({ root }).missing, ['notes.md']);
  });

  test('reports a covered file whose header is not the canonical rendering', () => {
    const root = fixtureTree({
      'settings.ts': `${blockHeader.replace('http://', 'https://')}\nconst a = 1;\n`,
    });
    assert.deepEqual(auditTree({ root }).unrecognized, ['settings.ts']);
  });

  /**
   * The gate cannot determine provenance, so it fails on an unreviewed claim of
   * one rather than deciding the question itself.
   */
  test('reports an unreviewed third-party origin claimed inside a covered file', () => {
    const root = fixtureTree({
      'adapted.ts': `${blockHeader}\n// Adapted from an upstream project.\nconst a = 1;\n`,
      'foreign.ts': `${blockHeader}\n// Copyright (c) 2020 Someone Else\nconst b = 2;\n`,
      'spdx.ts': `${blockHeader}\n// SPDX-License-Identifier: MIT\nconst c = 3;\n`,
      'plain.ts': `${blockHeader}\nconst d = 4;\n`,
    });
    assert.deepEqual(auditTree({ root }).unreviewedProvenance.sort(), [
      'adapted.ts',
      'foreign.ts',
      'spdx.ts',
    ]);
  });

  test('passes a tree whose covered files all carry the canonical header', () => {
    const root = fixtureTree({
      'README.md': renderHeader('html'),
      'settings.ts': `${blockHeader}\nconst a = 1;\n`,
      'package.json': '{}\n',
    });
    const result = auditTree({ root });
    for (const key of ['duplicated', 'irregular', 'missing', 'unclassified', 'unrecognized']) {
      assert.deepEqual(result[key], [], key);
    }
    assert.deepEqual(result.unreviewedProvenance, []);
    assert.equal(result.covered, 2);
  });
});
