import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createWindowsMaximizeRendererSync,
  type MaximizedRendererSyncWindow,
} from '../windows-maximize-renderer-sync.js';

function createFixture() {
  const calls: string[] = [];
  const deferred: Array<() => void> = [];
  let destroyed = false;
  let maximized = true;
  let webContentsDestroyed = false;
  const contentView = {};
  const window: MaximizedRendererSyncWindow<object> = {
    contentView,
    webContents: {
      isDestroyed: () => webContentsDestroyed,
      invalidate: () => calls.push('invalidate'),
    },
    isDestroyed: () => destroyed,
    isMaximized: () => maximized,
    setContentView: (view) => {
      assert.equal(view, contentView);
      calls.push('layout');
    },
  };

  return {
    calls,
    deferred,
    window,
    defer: (callback: () => void) => deferred.push(callback),
    setDestroyed: (value: boolean) => { destroyed = value; },
    setMaximized: (value: boolean) => { maximized = value; },
    setWebContentsDestroyed: (value: boolean) => { webContentsDestroyed = value; },
  };
}

describe('Windows maximize renderer sync', () => {
  it('defers one root layout and repaint for a maximized Windows window', () => {
    const fixture = createFixture();
    const schedule = createWindowsMaximizeRendererSync(fixture.window, {
      platform: 'win32',
      defer: fixture.defer,
    });

    schedule();
    schedule();
    assert.equal(fixture.deferred.length, 1);
    assert.deepEqual(fixture.calls, []);

    fixture.deferred.shift()?.();
    assert.deepEqual(fixture.calls, ['layout', 'invalidate']);
  });

  it('does nothing on non-Windows platforms', () => {
    const fixture = createFixture();
    const schedule = createWindowsMaximizeRendererSync(fixture.window, {
      platform: 'darwin',
      defer: fixture.defer,
    });

    schedule();
    assert.equal(fixture.deferred.length, 0);
    assert.deepEqual(fixture.calls, []);
  });

  it('drops deferred work when the window leaves maximized state or is destroyed', () => {
    const restored = createFixture();
    const scheduleRestored = createWindowsMaximizeRendererSync(restored.window, {
      platform: 'win32',
      defer: restored.defer,
    });
    scheduleRestored();
    restored.setMaximized(false);
    restored.deferred.shift()?.();

    const destroyed = createFixture();
    const scheduleDestroyed = createWindowsMaximizeRendererSync(destroyed.window, {
      platform: 'win32',
      defer: destroyed.defer,
    });
    scheduleDestroyed();
    destroyed.setDestroyed(true);
    destroyed.deferred.shift()?.();

    assert.deepEqual(restored.calls, []);
    assert.deepEqual(destroyed.calls, []);
  });

  it('does not touch a destroyed WebContents', () => {
    const fixture = createFixture();
    const schedule = createWindowsMaximizeRendererSync(fixture.window, {
      platform: 'win32',
      defer: fixture.defer,
    });

    schedule();
    fixture.setWebContentsDestroyed(true);
    fixture.deferred.shift()?.();

    assert.deepEqual(fixture.calls, []);
  });
});
