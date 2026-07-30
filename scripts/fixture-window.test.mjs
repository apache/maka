import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  assertInactiveWindowMappingSupported,
  mapFixtureWindowInactive,
} from './fixture-window.mjs';

function fakeElectronWindow({ visible = true, focused = false } = {}) {
  const page = {};
  const events = [];
  const window = {
    showInactive() {
      events.push('showInactive');
    },
    isVisible() {
      events.push('isVisible');
      return visible;
    },
    isFocused() {
      events.push('isFocused');
      return focused;
    },
  };
  const handle = {
    async evaluate(callback) {
      return callback(window);
    },
    async dispose() {
      events.push('dispose');
    },
  };
  return {
    page,
    events,
    app: {
      async browserWindow(target) {
        assert.equal(target, page);
        return handle;
      },
    },
  };
}

describe('assertInactiveWindowMappingSupported', () => {
  it('rejects native Wayland before an unsupported inactive launch', () => {
    assert.throws(
      () => assertInactiveWindowMappingSupported({ XDG_SESSION_TYPE: 'wayland' }, 'linux'),
      /XWayland.*--ozone-platform=x11/,
    );
  });
});

describe('mapFixtureWindowInactive', () => {
  it('maps the BrowserWindow that belongs to the launched page without focusing it', async () => {
    const { app, page, events } = fakeElectronWindow();

    await mapFixtureWindowInactive(app, page);

    assert.deepEqual(events, ['showInactive', 'isVisible', 'isFocused', 'dispose']);
  });

  it('fails closed and releases the handle when inactive mapping does not take effect', async () => {
    const { app, page, events } = fakeElectronWindow({ visible: false });

    await assert.rejects(() => mapFixtureWindowInactive(app, page), /visible=false focused=false/);
    assert.equal(events.at(-1), 'dispose');
  });
});
