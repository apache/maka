import { expect, test } from 'bun:test';
import { scopeHeadings, latestReleases, linkReferences, MAX_RELEASES, releasesDigest } from '../src/lib/releases.js';

const release = (n: number, extra = {}) => ({ tag_name: `v0.${n}.0`, published_at: new Date(2026, 0, n + 1).toISOString(), draft: false, ...extra });

test('the page shows the newest 20 releases, without drafts', () => {
  const items = Array.from({ length: 25 }, (_, n) => release(n, { draft: n === 24 }));
  const latest = latestReleases(items);
  expect(MAX_RELEASES).toBe(20);
  expect(latest.length).toBe(20);
  expect(latest[0].tag_name).toBe('v0.23.0');
  expect(latest.at(-1).tag_name).toBe('v0.4.0');
});

test('bare references link; URLs, addresses and fenced code stay', () => {
  expect(linkReferences('Fix (#12) by @huacnlee.')).toBe(
    'Fix ([#12](https://github.com/longbridge/nsh/issues/12)) by [@huacnlee](https://github.com/huacnlee).',
  );
  const kept = 'https://x.dev/a#12 me@x.dev `@types/node`\n```\n#12 @huacnlee\n```';
  expect(linkReferences(kept)).toBe(kept);
});

test('note headings take the tag, keep their links and sit below the version heading', () => {
  expect(scopeHeadings('<a href="#fixes">x</a><h2 id="fixes">Fixes</h2><h5 id="y">Y</h5>', 'v1.0.0')).toBe(
    '<a href="#v1.0.0-fixes">x</a><h4 id="v1.0.0-fixes">Fixes</h4><h6 id="v1.0.0-y">Y</h6>',
  );
});

test('the digest follows an edited note', () => {
  expect(releasesDigest([release(1, { body: 'a' })])).not.toBe(releasesDigest([release(1, { body: 'b' })]));
});
