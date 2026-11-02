import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paginateAll, paginateFeatured, selectShowcases, type BrowsedApp } from '../src/lib/showcase-browser';
import { loadShowcases } from '../src/lib/showcases';

// App Stories: reading the catalog of `nsh-showcases`, and browsing it.

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

async function catalog(apps: Record<string, object>, featured: string[], extra?: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'nsh-showcases-'));
  for (const [id, manifest] of Object.entries(apps)) {
    const dir = join(root, 'apps', id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ id, name: id, author: 'A', description: 'D', category: 'utility', platforms: ['macOS'], source: `https://github.com/a/${id}`, previews: ['preview0.png'], ...manifest }));
    await writeFile(join(dir, 'preview0.png'), PNG);
  }
  await writeFile(join(root, 'featured.json'), JSON.stringify(featured));
  await extra?.(root);
  return root;
}

describe('loadShowcases', () => {
  test('orders Featured apps first, then by ID, and lists media and READMEs', async () => {
    const root = await catalog({ alpha: {}, beta: {}, gamma: { website: 'https://gamma.dev', source: null } }, ['gamma'], async (root) => {
      await writeFile(join(root, 'apps', 'beta', 'README.md'), '# Beta');
      await writeFile(join(root, 'apps', 'beta', 'demo.mp4'), '');
    });
    try {
      const apps = await loadShowcases(root);
      expect(apps.map((app) => app.id)).toEqual(['gamma', 'alpha', 'beta']);
      expect(apps[0].featured).toBe(true);
      expect(apps[0].source).toBeNull();
      expect(apps[2].hasReadme).toBe(true);
      expect(apps[2].media).toEqual(['demo.mp4', 'preview0.png']);
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test('rejects a Featured ID that is not in the catalog', async () => {
    const root = await catalog({ alpha: {} }, ['missing']);
    try {
      await expect(loadShowcases(root)).rejects.toThrow('featured.json');
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test('rejects missing screenshots and media outside the app folder', async () => {
    const missing = await catalog({ alpha: { previews: ['preview1.png'] } }, []);
    const outside = await catalog({ alpha: {} }, [], async (root) => {
      await writeFile(join(root, 'secret.png'), PNG);
      await symlink(join(root, 'secret.png'), join(root, 'apps', 'alpha', 'leak.png'));
    });
    try {
      await expect(loadShowcases(missing)).rejects.toThrow('missing preview1.png');
      await expect(loadShowcases(outside)).rejects.toThrow('inside the app folder');
    } finally {
      await rm(missing, { recursive: true });
      await rm(outside, { recursive: true });
    }
  });
});

const app = (id: string, more: Partial<BrowsedApp> = {}): BrowsedApp => ({
  id, name: id, description: `${id} app`, category: 'utility', platforms: ['macOS'], featured: false, stars: null, publishedAt: null, ...more,
});

describe('selectShowcases', () => {
  const apps = [
    app('omasend', { featured: true, stars: 42, publishedAt: '2026-10-01T00:00:00Z', platforms: ['iOS', 'Android'] }),
    app('mado', { featured: true, category: 'work', publishedAt: '2026-10-20T00:00:00Z' }),
    app('sysmon', { stars: 14, publishedAt: '2026-09-01T00:00:00Z' }),
    app('disktree', { stars: 15, publishedAt: '2026-08-01T00:00:00Z' }),
  ];

  test('keeps the editorial Featured order and sorts the rest', () => {
    const newest = selectShowcases(apps);
    expect(newest.featured.map((a) => a.id)).toEqual(['omasend', 'mado']);
    expect(newest.all.map((a) => a.id)).toEqual(['mado', 'omasend', 'sysmon', 'disktree']);
    expect(selectShowcases(apps, { sort: 'stars' }).all.map((a) => a.id)).toEqual(['omasend', 'disktree', 'sysmon', 'mado']);
  });

  test('matches every search term and the category', () => {
    expect(selectShowcases(apps, { query: 'android OMA' }).all.map((a) => a.id)).toEqual(['omasend']);
    expect(selectShowcases(apps, { category: 'work' }).all.map((a) => a.id)).toEqual(['mado']);
    expect(selectShowcases(apps, { query: 'nothing' }).all).toEqual([]);
  });

  test('pages six Featured apps and nine of all, clamping the page', () => {
    const many = Array.from({ length: 20 }, (_, i) => app(`a${i}`, { featured: i < 8 }));
    expect(paginateFeatured(many, 2)).toMatchObject({ page: 2, totalPages: 2, total: 8 });
    expect(paginateFeatured(many, 2).apps).toHaveLength(2);
    expect(paginateAll(many, 9)).toMatchObject({ page: 3, totalPages: 3, total: 20 });
    expect(paginateAll(many, 0).apps.map((a) => a.id)[0]).toBe('a0');
  });
});
