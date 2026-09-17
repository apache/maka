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
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// This is a source replay, not a COM integration test. It executes the real
// selection loop and final checks against the narrow scripted Rust fixture.
// Exact rustfmt line boundaries deliberately fail on structural source drift;
// braces inside comments/strings are not parsed as Rust delimiters.
function item(source, name, indent) {
  const pattern = new RegExp(`^${' '.repeat(indent)}fn ${name}(?:<|\\()`, 'gm');
  const starts = [...source.matchAll(pattern)];
  assert.equal(starts.length, 1, `unique function ${name}`);
  const start = starts[0].index;
  const endMarker = `\n${' '.repeat(indent)}}\n`;
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `rustfmt end boundary for ${name}`);
  const value = source.slice(start, end + endMarker.length - 1);
  assert.equal([...value.matchAll(new RegExp(`^${' '.repeat(indent)}fn `, 'gm'))].length, 1,
    `no intervening peer function in ${name}`);
  return value;
}

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, `unique replay marker: ${before.slice(0, 60)}`);
  return source.replace(before, after);
}

// Exported so a local fail-before check can use the same renderer with a frozen
// source file. Normal test runs always load the repository source below.
export function renderReplay(source, fixture) {
  const visible = item(source, 'rich_visible_text', 8);
  const start = '            let limit = self.text_limit.saturating_sub(self.text.len()).min(8192);';
  assert.equal(visible.split(start).length, 2, 'unique acquisition start');
  assert.ok(visible.endsWith('            Some(Some(text))\n        }'), 'acquisition return boundary');
  let loop = visible.slice(visible.indexOf(start), -'        }'.length);
  const value = loop.includes('let value = VARIANT::from(true);') ? 'true' : 'false';
  const abi = `let value = VARIANT::from(${value});
                        let mut pointer = std::ptr::null_mut();
                        (Interface::vtable(&search).FindAttribute)(
                            search.as_raw(),
                            UIA_IsHiddenAttributeId,
                            std::mem::transmute_copy(&value),
                            false.into(),
                            &mut pointer,
                        )
                        .ok()?;
                        Ok((!pointer.is_null()).then(|| IUIAutomationTextRange::from_raw(pointer)))`;
  loop = replaceOnce(loop, abi, `search.FindAttribute(${value})`);
  assert.ok(!loop.includes('Interface::vtable'), 'all acquisition ABI calls accounted for');
  const methods = ['rich_run_current', 'sensitive', 'final_visible_text_check'];
  if (source.includes('        fn rich_range_current(')) methods.unshift('rich_range_current');
  const helpers = ['rich_range_readable', 'read_nonhidden_run', 'append_text', 'text_prefix'];
  fixture = replaceOnce(fixture, '/* HELPERS */', helpers.map(name => item(source, name, 0)).join('\n'));
  const targetStart = source.indexOf('    impl Target {\n');
  assert.ok(targetStart >= 0, 'Target implementation boundary');
  const targetEnd = source.indexOf('\n    }\n', targetStart);
  assert.ok(targetEnd > targetStart, 'Target implementation end');
  fixture = replaceOnce(fixture, '/* TARGET */', item(source.slice(targetStart, targetEnd + 1), 'read', 8));
  fixture = replaceOnce(fixture, '/* CHECKS */', methods.map(name => item(source, name, 8)).join('\n'));
  fixture = replaceOnce(fixture, '/* ACQUISITION */', loop);
  return fixture;
}

test('Rich acquisition coalesces visibility and retains privacy, budgets and final witnesses', async (t) => {
  const version = spawnSync('rustc', ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (version.error?.code === 'ENOENT') {
    t.skip('rustc is not installed; actual-source Rust replay requires the host compiler');
    return;
  }
  assert.equal(version.status, 0, version.error?.message || version.stderr);
  const source = await readFile(new URL('../native/computer-history-windows/src/platform/snapshot.rs', import.meta.url), 'utf8');
  const fixture = await readFile(new URL('./fixtures/computer-history-windows-rich-segmentation.rs', import.meta.url), 'utf8');
  const root = await mkdtemp(join(tmpdir(), 'maka-rich-replay with spaces-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'replay.rs');
  const binary = join(root, process.platform === 'win32' ? 'replay.exe' : 'replay');
  await writeFile(input, renderReplay(source, fixture));
  const compile = spawnSync('rustc', ['--edition=2024', '--test', input, '-o', binary], {
    encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(compile.status, 0, compile.error?.message || compile.stderr);
  const run = spawnSync(binary, ['--nocapture'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(run.status, 0, `${run.error?.message || ''}\n${run.stdout}\n${run.stderr}`);
  t.diagnostic(run.stdout.trim());
});
