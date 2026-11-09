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

import { Clipboard } from 'nsh';
import process from 'process';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { directory, prepare } from './storage';
import { homedir } from 'os';
import { join, basename, isAbsolute } from 'path';
import { qt } from '../shared/i18n.js';
import type { Services, ClipboardValue } from '../shared/plugin.js';

export async function run(command: string, args: string[], timeoutMs = 5000): Promise<string> {
  const result = await process.run(command, args, { timeoutMs });
  if (result.code !== 0) throw Error(result.stderr.trim() || `${command}: ${result.code}`);
  return result.stdout.trim();
}
export async function applications(): Promise<Services['applications.list']['output']> {
  if (process.platform !== 'macos') throw Error(qt('应用启动器目前支持 macOS'));
  const apps: Services['applications.list']['output'] = [];
  async function scan(root: string, depth: number) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (['ENOENT', 'EACCES'].includes((error as { code?: string }).code ?? '')) return;
      throw error;
    }
    for (const item of entries) {
      if (item.name.startsWith('.')) continue;
      const target = join(root, item.name);
      // Application symlinks (notably Safari) are valid launch targets;
      // enumerating them does not require reading outside the granted roots.
      if (item.name.endsWith('.app'))
        apps.push({ id: target, target, name: basename(target, '.app'), icon: 'application' });
      else if (item.isDirectory() && depth > 0) await scan(target, depth - 1);
    }
  }
  await Promise.all(
    ['/Applications', '/System/Applications', join(homedir(), 'Applications')].map((root) =>
      scan(root, 2),
    ),
  );
  // Batch helper requests stay below process argument/output limits.
  for (let offset = 0; process.env.MAKA_QUICK_NATIVE && offset < apps.length; offset += 32) {
    const batch = apps.slice(offset, offset + 32);
    const [icons, keywords] = await Promise.all([
      run(helperPath(), ['app-icons', JSON.stringify(batch.map((app) => app.target))]).then(
        (value) => JSON.parse(value) as string[],
      ),
      run(helperPath(), ['transliterate', JSON.stringify(batch.map((app) => app.name))]).then(
        (value) => JSON.parse(value) as string[],
      ),
    ]);
    batch.forEach((app, index) => {
      if (icons[index]?.startsWith('data:image/png;base64,'))
        app.icon = icons[index] as `data:image/png;base64,${string}`;
      app.keywords = keywords[index];
    });
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}
export async function open(target: string, reveal = false, quicklink = false) {
  if (target.startsWith('~/')) target = join(homedir(), target.slice(2));
  if (!target || /[\x00-\x1f]/.test(target)) throw Error(qt('无效目标'));
  if (!isAbsolute(target)) {
    const url = new URL(target);
    if (!quicklink && !['https:', 'http:'].includes(url.protocol))
      throw Error(qt('仅支持 HTTP(S) 网址和绝对文件路径'));
    if (reveal) throw Error(qt('网址不能在文件管理器中显示'));
  }
  if (process.platform === 'macos') await run('/usr/bin/open', reveal ? ['-R', target] : [target]);
  else if (process.platform === 'linux') await run('xdg-open', [target]);
  else throw Error(qt('此平台暂不支持打开目标'));
}
export function helperPath(): string {
  const path = process.env.MAKA_QUICK_NATIVE;
  if (!path) throw Error(qt('请通过原生快捷工具启动脚本运行 Maka'));
  return path;
}
export async function readClipboard(): Promise<ClipboardValue> {
  return JSON.parse(await run(helperPath(), ['clipboard-read']));
}
export async function writeClipboard(value: ClipboardValue) {
  if (!value.image) {
    await Clipboard.writeText(value.text ?? '');
    return;
  }
  await prepare();
  const file = join(directory(), `clipboard-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(file, JSON.stringify(value));
    await run(helperPath(), ['clipboard-write-file', file]);
  } finally {
    await fs.unlink(file).catch(() => {});
  }
}

const windows = new Set<ReturnType<typeof process.spawn>>();
export function imageWindow(
  kind: 'edit' | 'pin',
  file: string,
  locale: string,
  appearance: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let ready = false;
    const child = process.spawn(helperPath(), [kind, file, locale, appearance], { lines: true });
    windows.add(child);
    const timer = setTimeout(() => {
      if (!ready) {
        child.kill();
        reject(Error('Image window did not open'));
      }
    }, 10000);
    child.on('stdout', (line) => {
      try {
        if (JSON.parse(line).type === 'ready') {
          ready = true;
          clearTimeout(timer);
          resolve();
        }
      } catch {}
    });
    let stderr = '';
    child.on('stderr', (line) => {
      stderr = (stderr + line).slice(-2000);
    });
    child.on('exit', (exit) => {
      windows.delete(child);
      clearTimeout(timer);
      void fs.unlink(file).catch(() => {});
      if (!ready) reject(Error(stderr || `Image helper exited: ${exit.code}`));
    });
  });
}
export function closeImageWindows() {
  for (const child of windows) child.kill();
  windows.clear();
}
