import { lstat } from 'node:fs/promises';
import { join, parse } from 'node:path';

export async function hasEnclosingGitEntry(path: string): Promise<boolean> {
  let current = path;
  while (true) {
    try {
      await lstat(join(current, '.git'));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
    const parent = parse(current).dir;
    if (parent === current) return false;
    current = parent;
  }
}
