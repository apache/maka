import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  collapseHomePath,
  projectPathDisplay,
  truncatePathHead,
} from '../../renderer/project-path-display.js';

describe('collapseHomePath', () => {
  it('collapses the home prefix', () => {
    assert.equal(collapseHomePath('/Users/maka/Developer/app', '/Users/maka'), '~/Developer/app');
  });

  it('collapses the home directory itself to a bare ~', () => {
    assert.equal(collapseHomePath('/Users/maka', '/Users/maka'), '~');
  });

  it('only matches on a path boundary', () => {
    // The bug this pins: a prefix match would rewrite `/Users/maka-agent` to
    // `~-agent`, quietly renaming a different user's directory.
    assert.equal(
      collapseHomePath('/Users/maka-agent/app', '/Users/maka'),
      '/Users/maka-agent/app',
    );
  });

  it('leaves paths outside home alone', () => {
    assert.equal(collapseHomePath('/opt/work/app', '/Users/maka'), '/opt/work/app');
  });

  it('is a no-op when the home path is unknown', () => {
    // The renderer learns home asynchronously; before it arrives the path must
    // still render, just unabbreviated.
    assert.equal(collapseHomePath('/Users/maka/app', undefined), '/Users/maka/app');
  });

  it('ignores a trailing separator on the home path', () => {
    assert.equal(collapseHomePath('/Users/maka/app', '/Users/maka/'), '~/app');
  });
});

describe('truncatePathHead', () => {
  it('keeps the tail, which is the identifying end', () => {
    const result = truncatePathHead('/Users/maka/Developer/experiments/astryx-design-system', 24);
    assert.equal(result.length, 24);
    assert.ok(result.endsWith('astryx-design-system'), result);
    assert.ok(result.startsWith('…'), result);
  });

  it('leaves a path that already fits untouched', () => {
    // No decorative ellipsis on a path that never needed shortening.
    assert.equal(truncatePathHead('~/app', 24), '~/app');
  });

  it('leaves a path of exactly the budget untouched', () => {
    const exact = 'a'.repeat(24);
    assert.equal(truncatePathHead(exact, 24), exact);
  });
});

describe('projectPathDisplay', () => {
  it('collapses then truncates, and keeps the full path for the tooltip', () => {
    const display = projectPathDisplay(
      '/Users/maka/Developer/experiments/astryx-design-system',
      { homePath: '/Users/maka', maxLength: 20 },
    );

    // 20 is a tight budget on purpose: the folder name is itself 20 chars, so
    // the ellipsis has to eat into it. The tail is still what survives.
    assert.equal(display.text, '…stryx-design-system');
    assert.equal(display.text.length, 20);
    // The tooltip is the unabbreviated original — `~` is exactly what a user
    // consults the tooltip to expand.
    assert.equal(display.title, '/Users/maka/Developer/experiments/astryx-design-system');
  });

  it('shows a short home path whole', () => {
    const display = projectPathDisplay('/Users/maka/app', { homePath: '/Users/maka' });
    assert.equal(display.text, '~/app');
  });
});
