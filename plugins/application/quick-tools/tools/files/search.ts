/* Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE. */
import process from 'process';
import { qt } from '../../shared/i18n.js';
const active = new Set<ReturnType<typeof process.spawn>>();
export function stopFileSearches() {
  for (const child of active) child.kill();
  active.clear();
}
export function searchFileNames(
  root: string,
  query: string,
  signal: AbortSignal,
): Promise<string[]> {
  if (signal.aborted) return Promise.resolve([]);
  if (process.platform !== 'macos')
    return Promise.reject(Error(qt('文件名搜索依赖 macOS Spotlight')));
  return new Promise((resolve, reject) => {
    const child = process.spawn('/usr/bin/mdfind', ['-0', '-onlyin', root, '-name', query], {
      timeoutMs: 1800,
    });
    active.add(child);
    let output = '',
      settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      active.delete(child);
      child.kill();
      if (error) reject(error);
      else resolve(signal.aborted ? [] : output.split('\0').filter(Boolean).slice(0, 80));
    };
    const cancel = () => finish();
    signal.addEventListener('abort', cancel, { once: true });
    child.on('stdout', (chunk) => {
      output += chunk;
      if (output.length > 1024 * 1024 || output.split('\0').length > 80) finish();
    });
    child.on('exit', (exit) =>
      finish(exit.code && !signal.aborted ? Error(qt('文件搜索失败')) : undefined),
    );
  });
}
