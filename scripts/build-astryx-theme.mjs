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

// Build the Maka Astryx theme and strip its element-typography block (#1565 PR 3).
//
// `astryx theme build` compiles apps/desktop/src/renderer/astryx-theme/makaTheme.ts
// to maka.css + maka.js. The CSS always leads with an `@layer reset` block of
// @scope'd bare-element typography (:where(h1..h6, p, small, code, hr)) — the CLI
// deliberately removed its `--no-prose` flag to keep build output identical to the
// <Theme> runtime injector. styles.css explains why that block must not ship in
// Maka: bare-element rules win wherever no product rule competes, and no layer
// order can bury them.
//
// Stripping it here is NOT a build⇄runtime divergence for us: built themes
// (`__built: true`) skip runtime injection entirely (see @astryxdesign/core
// dist/theme/Theme.js useThemeStyleInjection), so the imported file is the only
// CSS source and what we strip stays stripped.
//
// Usage:
//   npm run astryx:theme
//   npm run astryx:theme -- --check
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = path.join(repoRoot, 'apps', 'desktop');
const themeDir = path.join(desktopDir, 'src', 'renderer', 'astryx-theme');
const themeSource = path.join('src', 'renderer', 'astryx-theme', 'makaTheme.ts');
const cssOut = path.join('src', 'renderer', 'astryx-theme', 'maka.css');
// @astryxdesign/cli 0.2.0 stopped emitting maka.variants.d.ts (`astryx theme
// build` now outputs css/js/d.ts only) — the file was tracked but never
// imported, so it is gone with the upgrade. The CLI's maka.d.ts still opens
// with a `/// <reference>` to it, though, so post-processing strips the
// dangling line (#1980) — without it every `tsc` run that resolves maka.d.ts
// leans on skipLibCheck to ignore the missing file.
const generatedFiles = ['maka.css', 'maka.js', 'maka.d.ts'];
const canonicalCommand =
  ' * Command: astryx theme build src/renderer/astryx-theme/makaTheme.ts --out ' +
  'src/renderer/astryx-theme/maka.css';
const postProcessNote =
  '/* Post-processed by scripts/build-astryx-theme.mjs: the @layer reset\n' +
  ' * element-typography block is stripped — see that script for why. */\n\n';

export function normalizeGeneratedHeader(source) {
  const withoutTimestamp = source.replace(/^ \* Generated: .*\n/m, '');
  return withoutTimestamp.replace(/^ \* Command: .*$/m, canonicalCommand);
}

export function stripResetLayer(css, file = cssOut) {
  const marker = '@layer reset {';
  const start = css.indexOf(marker);
  if (start === -1) {
    throw new Error(
      `${file}: expected a leading "@layer reset {" prose block; ` +
        'the astryx CLI output shape changed — re-verify the strip logic.',
    );
  }

  let depth = 0;
  let end = -1;
  for (let index = css.indexOf('{', start); index < css.length; index += 1) {
    const character = css[index];
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`${file}: unbalanced braces in the @layer reset block.`);
  if (css.indexOf(marker, end) !== -1) {
    throw new Error(`${file}: multiple @layer reset blocks; expected exactly one.`);
  }

  const stripped = css.slice(0, start).replace(/\s+$/, '\n\n') + css.slice(end).replace(/^\s+/, '');
  return stripped.replace('*/\n', `*/\n\n${postProcessNote}`);
}

export function stripVariantsReference(dts) {
  return dts.replace(/^\/\/\/\s*<reference\s+path="\.\/maka\.variants\.d\.ts"\s*\/>\s*\n/m, '');
}

function postProcessGeneratedFile(file, source) {
  const normalized = normalizeGeneratedHeader(source);
  if (file === 'maka.css') return stripResetLayer(normalized, file);
  if (file === 'maka.d.ts') return stripVariantsReference(normalized);
  return normalized;
}

function generateTheme(output, stdio) {
  const cli = fileURLToPath(import.meta.resolve('@astryxdesign/cli'));
  execFileSync(process.execPath, [cli, 'theme', 'build', themeSource, '-o', output], {
    cwd: desktopDir,
    stdio,
  });
}

export function buildAstryxTheme({ check = false, stdio = 'inherit' } = {}) {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'maka-astryx-theme-'));
  const output = path.join(temporaryDirectory, 'maka.css');
  try {
    generateTheme(output, stdio);
    const processedFiles = new Map(
      generatedFiles.map((file) => [
        file,
        postProcessGeneratedFile(file, readFileSync(path.join(temporaryDirectory, file), 'utf8')),
      ]),
    );
    const drifted = [];

    for (const [file, processed] of processedFiles) {
      const trackedPath = path.join(themeDir, file);
      if (check) {
        if (processed !== readFileSync(trackedPath, 'utf8')) drifted.push(file);
      } else {
        writeFileSync(trackedPath, processed);
      }
    }

    if (drifted.length > 0) {
      throw new Error(
        `Generated Astryx theme is stale: ${drifted.join(', ')}. Run "npm run astryx:theme" and commit the result.`,
      );
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  if (check) console.log('Astryx theme artifacts are current.');
  else console.log(`Built and normalized ${cssOut}.`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--check')) {
    throw new Error(`Unknown argument(s): ${args.filter((arg) => arg !== '--check').join(' ')}`);
  }
  buildAstryxTheme({ check: args.includes('--check') });
}
