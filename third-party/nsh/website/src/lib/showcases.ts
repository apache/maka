// App Stories' data: the reviewed catalog of `longbridge/nsh-showcases`,
// checked out next to this repository (`../nsh-showcases`) or at
// `SHOWCASES_DIR`. The catalog's own scripts validate it and render its
// READMEs; this module reads the manifests and the Featured order. The site
// serves each app's media from its own build (`pages/apps/[id]/[file].ts`).
import { existsSync } from 'node:fs';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ShowcaseApp {
  id: string;
  name: string;
  author: string;
  category: string;
  platforms: string[];
  website: string | null;
  source: string | null;
  description: string;
  building: boolean;
  featured: boolean;
  publishedAt: string | null;
  stars: number | null;
  starsUpdatedAt: string | null;
  /** Screenshot file names in the app's folder, the cover first. */
  previews: string[];
  /** Every media file of the app's folder, which the site serves. */
  media: string[];
  hasReadme: boolean;
}

const MEDIA = /^[a-z0-9]+(?:[._-][a-z0-9]+)*\.(png|mp4|webm)$/i;

/** Reads the catalog at `root`: apps in Featured order, then by ID. */
export async function loadShowcases(root: string): Promise<ShowcaseApp[]> {
  root = resolve(root);
  const apps: ShowcaseApp[] = [];
  const entries = await readdir(join(root, 'apps'), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const id = entry.name;
    const fail = (message: string): never => {
      throw new Error(`Showcase ${id}: ${message}`);
    };
    if (!entry.isDirectory()) fail('unexpected entry');
    const dir = join(root, 'apps', id);
    const realDir = await realpath(dir);
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || manifest.id !== id) fail('invalid app ID');
    if (!text(manifest.name) || !text(manifest.author) || !text(manifest.description) || !text(manifest.category)) fail('name, author, description and category are required');
    if (!Array.isArray(manifest.platforms) || !manifest.platforms.length || !manifest.platforms.every(text)) fail('missing platforms');
    if (Object.hasOwn(manifest, 'featured')) fail('featured belongs in root featured.json, not the manifest');
    for (const link of [manifest.website, manifest.source]) {
      if (link == null) continue;
      let protocol = '';
      try {
        protocol = new URL(link).protocol;
      } catch {}
      if (!['https:', 'http:'].includes(protocol)) fail('invalid project URL');
    }
    if (!manifest.website && !manifest.source) fail('a project link is required');
    if (!Array.isArray(manifest.previews) || !manifest.previews.length) fail('at least one preview is required');
    const files = await readdir(dir);
    const media = files.filter((name) => MEDIA.test(name)).sort();
    for (const name of [...manifest.previews, ...media]) {
      if (typeof name !== 'string' || !MEDIA.test(name)) fail(`invalid media file name: ${name}`);
      if (!files.includes(name)) fail(`missing ${name}`);
      if (!(await realpath(join(dir, name))).startsWith(realDir + sep)) fail(`${name} must stay inside the app folder`);
    }
    apps.push({
      id,
      name: manifest.name,
      author: manifest.author,
      category: manifest.category,
      platforms: manifest.platforms,
      website: manifest.website ?? null,
      source: manifest.source ?? null,
      description: manifest.description,
      building: manifest.building === true,
      featured: false,
      publishedAt: manifest.publishedAt ?? null,
      stars: Number.isInteger(manifest.stars) ? manifest.stars : null,
      starsUpdatedAt: manifest.starsUpdatedAt ?? null,
      previews: manifest.previews,
      media,
      hasReadme: files.includes('README.md'),
    });
  }
  const order = JSON.parse(await readFile(join(root, 'featured.json'), 'utf8'));
  if (!Array.isArray(order) || new Set(order).size !== order.length || order.some((id) => !apps.some((app) => app.id === id))) {
    throw new Error('Invalid Showcase featured.json');
  }
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  for (const app of apps) app.featured = order.includes(app.id);
  return apps.sort((a, b) => rank(a.id) - rank(b.id));
}

/** The catalog checkout: `SHOWCASES_DIR`, or `nsh-showcases` next to this repository. */
export const showcaseRoot = () => resolve(process.env.SHOWCASES_DIR ?? resolve(process.cwd(), '../../nsh-showcases'));

// The catalog's checked-in scripts belong to the same reviewed catalog; they
// run with its locked dependencies (`bun install --frozen-lockfile` there).
async function catalogModule(name: string) {
  return import(/* @vite-ignore */ pathToFileURL(join(showcaseRoot(), 'scripts', name)).href);
}

let catalog: Promise<ShowcaseApp[]> | undefined;

/**
 * The validated catalog. Without a checkout the site builds with no apps,
 * unless `NSH_REQUIRE_SHOWCASES` is set (the published site's build).
 */
export function getShowcaseApps(): Promise<ShowcaseApp[]> {
  return (catalog ??= (async () => {
    const root = showcaseRoot();
    if (!existsSync(join(root, 'apps'))) {
      if (process.env.NSH_REQUIRE_SHOWCASES) throw new Error(`No Showcase catalog at ${root}: set SHOWCASES_DIR`);
      return [];
    }
    const { validateCatalog } = await catalogModule('validate.ts');
    await validateCatalog(root);
    return loadShowcases(root);
  })());
}

/** The app's README as HTML, its media below `mediaBase`. */
export async function getShowcaseReadme(app: ShowcaseApp, mediaBase: string): Promise<string> {
  const { renderReadme } = await catalogModule('readme.ts');
  const markdown = await readFile(join(showcaseRoot(), 'apps', app.id, 'README.md'), 'utf8');
  return renderReadme(markdown, app, mediaBase);
}

/** An app media file's bytes. */
export function readShowcaseMedia(id: string, name: string): Promise<Buffer> {
  return readFile(join(showcaseRoot(), 'apps', id, name));
}
