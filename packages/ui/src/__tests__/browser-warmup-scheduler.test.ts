import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { createBrowserWarmupScheduler } from '../turn-size-warmup.js';

describe('createBrowserWarmupScheduler', () => {
  const original = {
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    requestIdleCallback: globalThis.requestIdleCallback,
    cancelIdleCallback: globalThis.cancelIdleCallback,
  };

  afterEach(() => {
    globalThis.requestAnimationFrame = original.requestAnimationFrame;
    globalThis.cancelAnimationFrame = original.cancelAnimationFrame;
    globalThis.requestIdleCallback = original.requestIdleCallback;
    globalThis.cancelIdleCallback = original.cancelIdleCallback;
  });

  it('passes a positive idle deadline so busy main threads still advance fill/warmup', () => {
    const idleOpts: IdleRequestOptions[] = [];
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      void cb;
      return 1;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
    globalThis.requestIdleCallback = ((cb: IdleRequestCallback, options?: IdleRequestOptions) => {
      void cb;
      idleOpts.push(options ?? {});
      return 7;
    }) as typeof requestIdleCallback;
    globalThis.cancelIdleCallback = (() => {}) as typeof cancelIdleCallback;

    const scheduler = createBrowserWarmupScheduler();
    assert.ok(scheduler, 'expected a browser scheduler when rAF exists');
    scheduler.requestIdle(() => {});

    assert.equal(idleOpts.length, 1);
    const timeout = idleOpts[0]?.timeout;
    assert.equal(typeof timeout, 'number');
    assert.ok(Number.isFinite(timeout));
    assert.ok((timeout as number) > 0);
  });

  it('returns undefined when requestAnimationFrame is unavailable', () => {
    // @ts-expect-error intentional absence for the SSR/no-window branch
    delete globalThis.requestAnimationFrame;
    assert.equal(createBrowserWarmupScheduler(), undefined);
  });
});
