import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { closeElectronApplication } from './electron-lifecycle.mjs';

// Bounded teardown is harness behavior, not product behavior: it drives a fake
// process handle and never launches Electron. It lives here beside
// fixture-window.test.mjs rather than in the Playwright suite, which would pay
// a real Electron boot slot to run assertions that need none.

class FakeElectronProcess extends EventEmitter {
  exitCode = null;
  signalCode = null;
  killedWith = undefined;

  kill(signal) {
    this.killedWith = signal;
    queueMicrotask(() => {
      this.signalCode = signal;
      this.emit('exit');
    });
    return true;
  }
}

/** An app whose graceful close never settles, so every test exercises the deadline. */
function wedgedApp(child) {
  return {
    close: () => new Promise(() => {}),
    process: () => child,
  };
}

describe('closeElectronApplication', () => {
  it('force-kills Electron when graceful teardown does not settle', async () => {
    const child = new FakeElectronProcess();
    let terminatedTree = false;

    const settled = await Promise.race([
      closeElectronApplication(wedgedApp(child), 0, async (target, signal) => {
        assert.equal(target, child);
        assert.equal(signal, 'SIGKILL');
        terminatedTree = true;
        child.signalCode = signal;
        child.emit('exit');
        return true;
      }).then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 25)),
    ]);

    assert.equal(settled, true);
    assert.equal(terminatedTree, true);
    assert.equal(child.killedWith, undefined);
  });

  it('falls back to a direct SIGKILL when the group kill misses the root', async () => {
    // The tree terminator signals the child's process group; on a child that is
    // not a group leader the group signal reports ESRCH and the terminator
    // returns as if the tree were gone while the root lives on. The bounded
    // close must then land a kill on the root itself — measured for real with
    // the smoke gate's visible window, which also ignores SIGTERM.
    const child = new FakeElectronProcess();

    await closeElectronApplication(wedgedApp(child), 0, async () => true);

    assert.equal(child.killedWith, 'SIGKILL');
    assert.equal(child.signalCode, 'SIGKILL');
  });
});
