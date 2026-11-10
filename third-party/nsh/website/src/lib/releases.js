// The release notes page's data: the newest GitHub releases, read when the
// site is built. `scripts/versions.js` also digests them, so an edited note
// rebuilds the root.
import { createHash } from 'node:crypto';

export const RELEASE_REPO = 'longbridge/nsh';
export const MAX_RELEASES = 20;

/** Non-draft releases, newest first, at most `MAX_RELEASES`. */
export function latestReleases(items) {
  return items
    .filter((item) => !item.draft)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
    .slice(0, MAX_RELEASES);
}

/**
 * The newest releases from GitHub. A build that publishes the site sets
 * `NSH_REQUIRE_RELEASES`: it fails here instead of publishing an empty page.
 */
export async function fetchReleases() {
  const headers = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    // A page wider than the limit, so drafts cannot push out published releases.
    const response = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=${MAX_RELEASES + 10}`, { headers });
    const items = await response.json();
    if (!response.ok || !Array.isArray(items)) throw new Error(`GitHub API returned ${response.status}`);
    return latestReleases(items);
  } catch (error) {
    if (process.env.NSH_REQUIRE_RELEASES) throw error;
    console.warn(`[releases] ${error}`);
    return [];
  }
}

/** Changes whenever the page's content does. */
export function releasesDigest(items) {
  const content = items.map((item) => [item.tag_name, item.name, item.published_at, item.prerelease, item.body]);
  return createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
}

// GitHub links `#123` and `@login` when it shows a release; the API returns
// them as typed. Only bare references are linked, and fenced code stays as it is.
export function linkReferences(markdown) {
  return markdown
    .split(/(^```[\s\S]*?^```$)/m)
    .map((part, index) =>
      index % 2
        ? part
        : part
            .replace(/(^|[\s(])#(\d+)(?=[\s.,;:)]|$)/gm, `$1[#$2](https://github.com/${RELEASE_REPO}/issues/$2)`)
            .replace(/(^|[\s(])@([A-Za-z\d](?:[A-Za-z\d-]{0,37}[A-Za-z\d])?)(?=[\s.,;:)]|$)/gm, '$1[@$2](https://github.com/$2)'),
    )
    .join('');
}

// Notes repeat their headings across versions, so their ids take the tag, as
// do the links to them inside a note. They also sit below the version heading.
export function scopeHeadings(html, tag) {
  return html
    .replace(/<h([1-6])\s+id="([^"]*)"/g, `<h$1 id="${tag}-$2"`)
    .replace(/href="#([^"]+)"/g, `href="#${tag}-$1"`)
    .replace(/<(\/?)h([1-6])(?=[\s>])/g, (_, slash, level) => `<${slash}h${Math.min(Number(level) + 2, 6)}`);
}

/** The releases as the page shows them: notes rendered like the docs' code. */
export async function loadReleases() {
  const items = await fetchReleases();
  if (items.length === 0) return [];
  const { createMarkdownProcessor } = await import('@astrojs/markdown-remark');
  const { shikiConfig } = await import('./markdown.js');
  const processor = await createMarkdownProcessor({ shikiConfig, defaultHighlightLang: 'sh' });
  const latestStable = items.find((item) => !item.prerelease);
  return Promise.all(
    items.map(async (item) => ({
      tag: item.tag_name,
      name: item.name || item.tag_name,
      date: item.published_at.slice(0, 10),
      url: item.html_url,
      prerelease: item.prerelease,
      latest: item === latestStable,
      html: scopeHeadings((await processor.render(linkReferences((item.body ?? '').replace(/\r\n/g, '\n')))).code, item.tag_name),
    })),
  );
}
