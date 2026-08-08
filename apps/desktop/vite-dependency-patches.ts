import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

export function dependencyPatchesCachePlugin(repoRoot: string): Plugin {
  const patchesDir = resolve(repoRoot, 'patches');
  const hash = createHash('sha256');
  for (const file of readdirSync(patchesDir).filter(file => file.endsWith('.patch')).sort()) {
    hash.update(file).update('\0').update(readFileSync(resolve(patchesDir, file)));
  }
  return { name: `maka-dependency-patches-${hash.digest('hex')}` };
}
