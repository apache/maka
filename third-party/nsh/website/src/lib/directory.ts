// The Directory's data: community libraries, components, templates and tools
// from `directory/` in `longbridge/nsh-showcases` (the same checkout as App
// Stories, see `showcases.ts`). The catalog's own script validates it.
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { showcaseRoot } from './showcases';

export interface DirectoryEntry {
  id: string;
  name: string;
  author: string;
  description: string;
  category: string;
  platforms: string[];
  source: string;
  website: string | null;
  publishedAt: string | null;
  stars: number | null;
}

/** Category IDs in the order the page lists them, with their labels. */
export const DIRECTORY_CATEGORIES: [id: string, en: string, zh: string][] = [
  ['library', 'Libraries', '功能库'],
  ['component', 'Components', '组件'],
  ['template', 'Templates', '模板'],
  ['tool', 'Tools', '工具'],
];

/** Reads `directory/` at `root`: most GitHub Stars first, then by name. */
export async function loadDirectory(root: string): Promise<DirectoryEntry[]> {
  const dir = join(resolve(root), 'directory');
  if (!existsSync(dir)) return [];
  const entries: DirectoryEntry[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const m = JSON.parse(await readFile(join(dir, entry.name, 'manifest.json'), 'utf8'));
    if (m.id !== entry.name) throw new Error(`Directory ${entry.name}: manifest ID must match its folder`);
    entries.push({
      id: m.id,
      name: m.name,
      author: m.author,
      description: m.description,
      category: m.category,
      platforms: Array.isArray(m.platforms) ? m.platforms : [],
      source: m.source,
      website: m.website ?? null,
      publishedAt: m.publishedAt ?? null,
      stars: Number.isInteger(m.stars) ? m.stars : null,
    });
  }
  return entries.sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1) || a.name.localeCompare(b.name));
}

let cached: Promise<DirectoryEntry[]> | undefined;

/** The validated Directory; empty without a catalog checkout or an older catalog. */
export function getDirectory(): Promise<DirectoryEntry[]> {
  return (cached ??= (async () => {
    const root = showcaseRoot();
    if (!existsSync(join(root, 'directory'))) return [];
    const { validateDirectory } = await import(/* @vite-ignore */ pathToFileURL(join(root, 'scripts', 'validate.ts')).href);
    await validateDirectory?.(root);
    return loadDirectory(root);
  })());
}
