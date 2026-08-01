import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { inactiveWindowElectronArgs, mapFixtureWindowInactive } from './fixture-window.mjs';

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

describe('inactiveWindowElectronArgs', () => {
  it('forces XWayland only when Electron would otherwise use native Wayland', () => {
    assert.deepEqual(inactiveWindowElectronArgs({ XDG_SESSION_TYPE: 'wayland' }, 'linux'), [
      '.',
      '--ozone-platform=x11',
    ]);
    assert.deepEqual(inactiveWindowElectronArgs({ XDG_SESSION_TYPE: 'x11' }, 'linux'), ['.']);
    assert.deepEqual(inactiveWindowElectronArgs({ XDG_SESSION_TYPE: 'wayland' }, 'darwin'), ['.']);
  });
});

describe('mapFixtureWindowInactive', () => {
  it('fails closed and releases the handle when inactive mapping does not take effect', async () => {
    const { app, page, events } = fakeElectronWindow({ visible: false });

    await assert.rejects(() => mapFixtureWindowInactive(app, page), /visible=false focused=false/);
    assert.equal(events.at(-1), 'dispose');
  });
});
