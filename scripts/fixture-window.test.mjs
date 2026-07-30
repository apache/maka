import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { mapFixtureWindowInactive, resolveFixtureWindowMode } from './fixture-window.mjs';

describe('resolveFixtureWindowMode', () => {
  it('keeps foreground and inactive mapping mutually exclusive', () => {
    assert.throws(
      () =>
        resolveFixtureWindowMode({
          showWindow: true,
          mapWindowInactive: true,
          ciLinuxDisplay: false,
        }),
      /mutually exclusive/,
    );
  });

  it('selects one compositor mode without making inactive launches foreground', () => {
    assert.equal(resolveFixtureWindowMode({ ciLinuxDisplay: false }), 'hidden');
    assert.equal(
      resolveFixtureWindowMode({ mapWindowInactive: true, ciLinuxDisplay: false }),
      'inactive',
    );
    assert.equal(resolveFixtureWindowMode({ showWindow: true, ciLinuxDisplay: false }), 'visible');
    assert.equal(
      resolveFixtureWindowMode({ mapWindowInactive: true, ciLinuxDisplay: true }),
      'visible',
    );
  });
});

describe('mapFixtureWindowInactive', () => {
  it('maps the BrowserWindow that belongs to the launched page without focusing it', async () => {
    const page = {};
    const events = [];
    const window = {
      showInactive() {
        events.push('showInactive');
      },
    };
    const handle = {
      async evaluate(callback) {
        callback(window);
      },
      async dispose() {
        events.push('dispose');
      },
    };
    const app = {
      async browserWindow(target) {
        assert.equal(target, page);
        return handle;
      },
    };

    await mapFixtureWindowInactive(app, page);

    assert.deepEqual(events, ['showInactive', 'dispose']);
  });
});
