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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '../test-helpers.js';
import { LocalWorkspaceExecutor } from '../workspace-executor.js';

const ONE_PIXEL_IMAGES = [
  [
    'image.PNG',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
    'image/png',
  ],
  [
    'image.jpg',
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9k=',
    'image/jpeg',
  ],
  ['image.jpeg', 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'image/gif'],
  ['image.webp', 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vuUAAA=', 'image/webp'],
] as const;
const ONE_PIXEL_PNG = Buffer.from(ONE_PIXEL_IMAGES[0][1], 'base64');

describe('LocalWorkspaceExecutor exec', () => {
  test('runs commands in the provided cwd and streams stdout/stderr', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-exec-'));
    await writeFile(join(cwd, 'marker.txt'), 'from-cwd', 'utf8');
    const executor = new LocalWorkspaceExecutor();
    const events: Array<{ stream: 'stdout' | 'stderr'; chunk: string }> = [];

    const result = await executor.exec({
      command: 'printf "$(cat marker.txt)"; printf "err-data" >&2',
      cwd,
      timeoutMs: 5_000,
      emitOutput: (stream, chunk) => events.push({ stream, chunk }),
    });

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: 'from-cwd',
      stderr: 'err-data',
    });
    expect(
      events.some((event) => event.stream === 'stdout' && event.chunk.includes('from-cwd')),
    ).toBe(true);
    expect(
      events.some((event) => event.stream === 'stderr' && event.chunk.includes('err-data')),
    ).toBe(true);
  });

  test('reports non-zero exit without throwing so tools can preserve their own error contract', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-exec-'));
    const executor = new LocalWorkspaceExecutor();

    const result = await executor.exec({
      command: 'printf "out-data"; printf "err-data" >&2; exit 7',
      cwd,
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      exitCode: 7,
      stdout: 'out-data',
      stderr: 'err-data',
    });
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
  });

  test('runs argv commands without routing through the host shell', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-exec-argv-'));
    const executor = new LocalWorkspaceExecutor();

    const result = await executor.exec({
      command: 'ignored display command',
      argv: [
        process.execPath,
        '-e',
        'process.stdout.write(process.argv[1])',
        'literal $HOME && ok',
      ],
      cwd,
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: 'literal $HOME && ok',
      stderr: '',
    });
  });

  test('reports timeout with captured output', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-exec-'));
    const executor = new LocalWorkspaceExecutor();

    const result = await executor.exec({
      command: 'printf "before-timeout"; sleep 5',
      cwd,
      timeoutMs: 200,
    });

    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe('before-timeout');
  });

  test('reports abort with captured output', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-exec-'));
    const executor = new LocalWorkspaceExecutor();
    const controller = new AbortController();

    const resultPromise = executor.exec({
      command: 'printf "before-abort"; sleep 5; printf "after-abort"',
      cwd,
      timeoutMs: 5_000,
      abortSignal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await resultPromise;

    expect(result.exitCode).toBe(130);
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe('before-abort');
  });
});

describe('LocalWorkspaceExecutor file operations', () => {
  test('reads valid PNG, JPEG, GIF, and WebP images by magic bytes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-images-'));
    const executor = new LocalWorkspaceExecutor();

    for (const [name, base64, mimeType] of ONE_PIXEL_IMAGES) {
      const file = join(cwd, name);
      const bytes = Buffer.from(base64, 'base64');
      await writeFile(file, bytes);
      const result = await executor.readFile({ cwd, path: file });
      if (!('bytes' in result)) throw new Error('expected image result');
      expect(result.mimeType).toBe(mimeType);
      expect([...result.bytes]).toEqual([...bytes]);
    }
  });

  test('ignores text windows when reading an image', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-images-'));
    const executor = new LocalWorkspaceExecutor();
    const file = join(cwd, 'image.png');
    await writeFile(file, ONE_PIXEL_PNG);

    const result = await executor.readFile({ cwd, path: file, offset: 1, limit: 1 });

    if (!('bytes' in result)) throw new Error('expected image result');
    expect([...result.bytes]).toEqual([...ONE_PIXEL_PNG]);
  });

  test('rejects extension-only and over-limit image files', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-images-'));
    const executor = new LocalWorkspaceExecutor();
    const fake = join(cwd, 'fake.png');
    const huge = join(cwd, 'huge.webp');
    await writeFile(fake, 'not an image');
    await writeFile(huge, 'RIFF0000WEBP');
    await truncate(huge, 5 * 1024 * 1024 + 1);

    await assert.rejects(
      executor.readFile({ cwd, path: fake }),
      /^Error: Image content is not a supported PNG, JPEG, GIF, or WebP file\.$/,
    );
    await assert.rejects(
      executor.readFile({ cwd, path: huge }),
      /exceeds the 5MB model input limit/,
    );
  });

  test('reads and writes text files by absolute path', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-files-'));
    const executor = new LocalWorkspaceExecutor();
    const file = join(cwd, 'data.txt');

    const writeResult = await executor.writeFile({ cwd, path: file, content: 'hello' });
    const readResult = await executor.readFile({ cwd, path: file });

    expect(writeResult).toMatchObject({
      ok: true,
      path: file,
      bytes: 5,
    });
    expect(readResult).toMatchObject({ content: 'hello' });
    expect(await readFile(file, 'utf8')).toBe('hello');
  });

  test('applies read offset and limit at the executor boundary', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-files-'));
    const executor = new LocalWorkspaceExecutor();
    const file = join(cwd, 'data.txt');
    await writeFile(file, 'line1\nline2\nline3\nline4', 'utf8');

    const readResult = await executor.readFile({ cwd, path: file, offset: 1, limit: 2 });

    expect(readResult).toMatchObject({ content: 'line2\nline3' });
  });

  test('globs files from the provided cwd with a result cap', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-glob-'));
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'src', 'a.ts'), 'a', 'utf8');
    await writeFile(join(cwd, 'src', 'b.ts'), 'b', 'utf8');
    await writeFile(join(cwd, 'src', 'c.js'), 'c', 'utf8');
    const executor = new LocalWorkspaceExecutor();

    const result = await executor.globFiles({ cwd, pattern: 'src/*.*', limit: 2 });

    expect(result.files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  test('greps file contents with rg-compatible no-match behavior', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-grep-'));
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'src', 'main.ts'), 'export const token = 1; // --flag\n', 'utf8');
    const executor = new LocalWorkspaceExecutor();

    const hit = await executor.grepFiles({
      cwd,
      pattern: 'token',
      path: join(cwd, 'src'),
      maxCountPerFile: 50,
      limit: 200,
      timeoutMs: 5_000,
    });
    const miss = await executor.grepFiles({
      cwd,
      pattern: 'absent',
      path: join(cwd, 'src'),
      maxCountPerFile: 50,
      limit: 200,
      timeoutMs: 5_000,
    });
    const optionLikePattern = await executor.grepFiles({
      cwd,
      pattern: '--flag',
      path: join(cwd, 'src'),
      maxCountPerFile: 50,
      limit: 200,
      timeoutMs: 5_000,
    });

    expect(hit.matches).toEqual([
      `${join(cwd, 'src', 'main.ts')}:1:export const token = 1; // --flag`,
    ]);
    expect(miss).toMatchObject({ matches: [] });
    expect(optionLikePattern.matches).toEqual([
      `${join(cwd, 'src', 'main.ts')}:1:export const token = 1; // --flag`,
    ]);
  });
});
