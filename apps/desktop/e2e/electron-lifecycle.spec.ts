import { EventEmitter } from 'node:events';
import { test, expect } from '@playwright/test';
import { closeElectronApplication } from '../../../scripts/electron-lifecycle.mjs';

// Local shapes for the fake: the implementation moved to a plain-node .mjs
// (shared with the migration contract harness), which carries its types as
// JSDoc rather than exported interfaces.
interface ElectronProcessHandle {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: 'exit', listener: () => void): unknown;
  off(event: 'exit', listener: () => void): unknown;
}

interface ClosableElectronApplication {
  close(): Promise<void>;
  process(): ElectronProcessHandle;
}

class FakeElectronProcess extends EventEmitter implements ElectronProcessHandle {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killedWith: NodeJS.Signals | undefined;

  kill(signal: NodeJS.Signals): boolean {
    this.killedWith = signal;
    queueMicrotask(() => {
      this.signalCode = signal;
      this.emit('exit');
    });
    return true;
  }

  override once(event: 'exit', listener: () => void): this {
    return super.once(event, listener);
  }

  override off(event: 'exit', listener: () => void): this {
    return super.off(event, listener);
  }
}

test('force-kills Electron when graceful E2E teardown does not settle', async () => {
  const child = new FakeElectronProcess();
  const app: ClosableElectronApplication = {
    close: () => new Promise<void>(() => {}),
    process: () => child,
  };

  let terminatedTree = false;
  const settled = await Promise.race([
    closeElectronApplication(app, 0, async (target, signal) => {
      expect(target).toBe(child);
      expect(signal).toBe('SIGKILL');
      terminatedTree = true;
      child.signalCode = signal;
      child.emit('exit');
      return true;
    }).then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
  ]);

  expect(settled).toBe(true);
  expect(terminatedTree).toBe(true);
  expect(child.killedWith).toBeUndefined();
});

test('falls back to a direct SIGKILL when the group kill misses the root', async () => {
  // The tree terminator signals the child's process group; on a child that is
  // not a group leader the group signal reports ESRCH and the terminator
  // returns as if the tree were gone while the root lives on. The bounded
  // close must then land a kill on the root itself — measured for real with
  // the smoke gate's visible window, which also ignores SIGTERM.
  const child = new FakeElectronProcess();
  const app: ClosableElectronApplication = {
    close: () => new Promise<void>(() => {}),
    process: () => child,
  };

  await closeElectronApplication(app, 0, async () => true);

  expect(child.killedWith).toBe('SIGKILL');
  expect(child.signalCode).toBe('SIGKILL');
});
