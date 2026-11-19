// Builds the site with every version of the documentation, as GPUI Kit's
// does: the latest release at /, `main` (this checkout) at /versions/main and
// each earlier release at /versions/<tag>, all into website/dist.
//
// Every version is built with this checkout's site (layouts, components,
// styles, the version menu); only what a release documents comes from its
// tag: the pages (`docs`, `elements`, `modules`, `zh-CN`) and the demos, which
// run on that release's own WebAssembly runtime (its `cargo xtask web`, in a
// worktree of the tag), so a page and its live demo always match.
//
// A release's built pages are kept in `.versions/` (CI caches it) under the
// tag and a digest of this checkout's site, and its player under the tag
// alone: a release is built once, and again only when the site changes. The
// latest's is also kept under the catalog's commit and a digest of the release
// notes, since only it has App Stories and the notes, which change apart from
// releases.
//
//   bun scripts/play.js && bun scripts/versions.js     (`bun run build:versions`)
//
// `NSH_SITE_VERSIONS=main,v0.3.0` limits the releases built (all listed still).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchReleases, releasesDigest } from '../src/lib/releases.js';

const website = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(website, '..');
const dist = join(website, 'dist');
const cache = process.env.NSH_SITE_VERSION_CACHE ?? join(website, '.versions');
const showcases = process.env.SHOWCASES_DIR ?? resolve(root, '..', 'nsh-showcases');

/** What a release takes from its tag; everything else is this checkout's. */
const CONTENT = ['docs', 'elements', 'modules', 'zh-CN', 'demos'];
/** The first release whose site this one can build. */
const FIRST = [0, 2, 0];
const MAX_RELEASES = 20;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) {
    console.error(`[versions] failed: ${command} ${args.join(' ')}`);
    process.exit(1);
  }
}

function git(...args) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }).stdout.trim();
}

// Stable releases from FIRST on, newest first.
spawnSync('git', ['-C', root, 'fetch', '--quiet', '--tags', 'origin'], { stdio: 'inherit' });
const releases = git('tag', '--list', 'v*', '--sort=-version:refname')
  .split('\n')
  .filter((tag) => {
    const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
    if (!match) return false;
    const version = match.slice(1).map(Number);
    for (let i = 0; i < 3; i++) if (version[i] !== FIRST[i]) return version[i] > FIRST[i];
    return true;
  })
  .slice(0, MAX_RELEASES);
const latest = releases[0] ?? 'main';
const versions = ['main', ...releases].map((id) => ({ id, label: id }));
const only = process.env.NSH_SITE_VERSIONS?.split(',').filter(Boolean);

// The site's own files (all but the content and what is built): a change to
// them rebuilds every release.
const siteDigest = (() => {
  const files = git('ls-files', '--', 'website', 'examples/nsh-gallery-ui')
    .split('\n')
    .filter((file) => file && !CONTENT.some((dir) => file.startsWith(`website/${dir}/`)))
    .sort();
  const hash = createHash('sha256');
  for (const file of files) {
    const path = join(root, file);
    if (existsSync(path)) hash.update(file).update(readFileSync(path));
  }
  return hash.digest('hex').slice(0, 16);
})();

// The catalog's commit: a merged app has to reach the root's App Stories.
const catalog = spawnSync('git', ['-C', showcases, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() ?? '';
if (!catalog && process.env.NSH_REQUIRE_SHOWCASES) {
  console.error(`[versions] no App Stories catalog commit at ${showcases}`);
  process.exit(1);
}

// The release notes: an edited note has to reach the root's page too.
const notes = releasesDigest(await fetchReleases());

// Machine translations are the root's alone (`src/lib/locales.ts`).
const translations = (() => {
  const dir = join(website, 'translations');
  const hash = createHash('sha256');
  if (existsSync(dir)) {
    const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((file) => file.isFile());
    for (const path of files.map((file) => join(file.parentPath, file.name)).sort()) {
      hash.update(path.slice(dir.length)).update(readFileSync(path));
    }
  }
  return hash.digest('hex').slice(0, 16);
})();

// On the file system of `dist` (Astro moves its output there, which fails
// across file systems) and outside `website/`, which each version copies.
mkdirSync(join(root, '.nsh'), { recursive: true });
const work = mkdtempSync(join(root, '.nsh', 'site-versions-'));
process.on('exit', () => {
  rmSync(work, { recursive: true, force: true });
  spawnSync('git', ['-C', root, 'worktree', 'prune']);
});

/**
 * A copy of this checkout's site to build one version in, at
 * `<work>/<id>/website`: the repository's other directories are linked next
 * to it, so paths that leave `website/` (the gallery's shared UI) resolve.
 */
function siteCopy(id) {
  const dir = join(work, id);
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(root)) {
    if (entry !== 'website' && entry !== '.git' && entry !== '.nsh') symlinkSync(join(root, entry), join(dir, entry));
  }
  const copy = join(dir, 'website');
  cpSync(website, copy, {
    recursive: true,
    filter: (source) => {
      const rel = source.slice(website.length).replace(/^\/+/, '');
      return !['node_modules', 'dist', '.astro', '.versions', 'public/play'].some(
        (skip) => rel === skip || rel.startsWith(`${skip}/`),
      );
    },
  });
  symlinkSync(join(website, 'node_modules'), join(copy, 'node_modules'));
  return copy;
}

/** Replaces a copy's content with the tag's. */
function takeContent(copy, tag) {
  const present = CONTENT.filter((dir) => git('cat-file', '-t', `${tag}:website/${dir}`) === 'tree');
  for (const dir of CONTENT) rmSync(join(copy, dir), { recursive: true, force: true });
  const paths = present.map((dir) => `website/${dir}`).join(' ');
  run('sh', ['-c', `git -C "${root}" archive ${tag} ${paths} | tar -x --strip-components=1 -C "${copy}"`]);
  // The demos' tsconfig extends the generated `.nsh/tsconfig.json`, which
  // no tag holds; Vite reads it to transform the demos' sources.
  const types = join(website, 'demos', '.nsh');
  if (existsSync(types)) cpSync(types, join(copy, 'demos', '.nsh'), { recursive: true });
}

/**
 * The toolchain's own Cargo, which huacnlee/cargo stands in front of on the
 * PATH: a release's xtask (v0.4.0 and earlier) builds the playground with
 * `--target-dir` and reads the file from there, which huacnlee/cargo ignores.
 */
function toolchainCargo(cwd) {
  const which = spawnSync('rustup', ['which', 'cargo'], { cwd, encoding: 'utf8' });
  return which.status === 0 ? which.stdout.trim() : 'cargo';
}

/** The tag's player and demos, built by its own `cargo xtask web` once. */
function releasePlayer(tag) {
  const dir = join(cache, tag, 'play');
  if (existsSync(join(dir, 'index.html'))) return dir;
  const checkout = join(work, `checkout-${tag}`);
  run('git', ['-C', root, 'worktree', 'add', '--detach', checkout, tag]);
  console.log(`[versions] building the player of ${tag}`);
  // In the tag's own target directory, where its xtask reads what it built;
  // the xtask builds with the Cargo that runs it (`CARGO`).
  run(toolchainCargo(checkout), ['xtask', 'web'], { cwd: checkout });
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(cache, tag), { recursive: true });
  cpSync(join(checkout, 'website', 'public', 'play'), dir, { recursive: true });
  return dir;
}

function build(version, copy, out) {
  const base = version === latest ? '/' : `/versions/${version}/`;
  console.log(`[versions] building ${version} at ${base}`);
  run('bunx', ['--bun', 'astro', 'build'], {
    cwd: copy,
    env: {
      ...process.env,
      PUBLIC_SITE_BASE: base,
      PUBLIC_SITE_VERSION: version,
      PUBLIC_SITE_LATEST_VERSION: latest,
      PUBLIC_SITE_VERSIONS: JSON.stringify(versions),
      SITE_OUT_DIR: out,
      SHOWCASES_DIR: showcases,
    },
  });
  // App Stories and the release notes are the latest's alone: both change
  // apart from a version's content, so other versions link to the root's.
  if (version !== latest) {
    for (const dir of ['apps', 'zh-CN/apps', 'releases', 'zh-CN/releases']) rmSync(join(out, dir), { recursive: true, force: true });
  }
  run('bunx', ['pagefind', '--site', out]);
}

rmSync(dist, { recursive: true, force: true });
// The root first: its search index must not take in the versions below it.
const order = [latest, ...versions.map((v) => v.id).filter((id) => id !== latest)];
for (const version of order) {
  if (only && !only.includes(version)) continue;
  const out = version === latest ? dist : join(dist, 'versions', version);
  const cached = join(cache, version, version === latest ? `${siteDigest}-${catalog}-${notes}-${translations}` : siteDigest);
  if (version !== 'main' && existsSync(join(cached, 'index.html'))) {
    console.log(`[versions] reusing ${version}`);
    cpSync(cached, out, { recursive: true });
    continue;
  }
  const copy = siteCopy(version);
  if (version !== latest) rmSync(join(copy, 'translations'), { recursive: true, force: true });
  if (version === 'main') {
    const play = join(website, 'public', 'play');
    if (existsSync(play)) cpSync(play, join(copy, 'public', 'play'), { recursive: true });
  } else {
    takeContent(copy, version);
    cpSync(releasePlayer(version), join(copy, 'public', 'play'), { recursive: true });
  }
  // The root's build owns `dist`: keep what Astro would clear of the others.
  build(version, copy, version === latest ? out : join(work, `out-${version}`));
  if (version !== latest) cpSync(join(work, `out-${version}`), out, { recursive: true });
  if (version !== 'main') {
    // Builds of an earlier site go; the player (keyed by the tag alone) stays.
    mkdirSync(join(cache, version), { recursive: true });
    for (const entry of readdirSync(join(cache, version))) {
      if (entry !== 'play') rmSync(join(cache, version, entry), { recursive: true, force: true });
    }
    cpSync(out, cached, { recursive: true });
  }
}
