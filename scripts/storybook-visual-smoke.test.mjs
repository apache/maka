import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import { installStorybookSmokeProbe, smokeStory } from './storybook-visual-smoke.mjs';

class FakePage extends EventEmitter {
  constructor(onGoto, evaluation = true) {
    super();
    this.onGoto = onGoto;
    this.evaluation = evaluation;
  }

  async addInitScript() {}
  async setViewportSize() {}
  async waitForFunction() {}

  async goto() {
    this.onGoto?.(this);
  }

  async evaluate() {
    return this.evaluation;
  }
}

const job = {
  surface: 'skills',
  storyId: 'product-module-hubs--extensions-skills',
  viewport: 'floor',
  size: { width: 480, height: 900 },
};

describe('Product Storybook browser smoke', () => {
  it('captures Storybook play-function failures', () => {
    const handlers = {};
    const previousWindow = globalThis.window;
    globalThis.window = {
      __STORYBOOK_PREVIEW__: {
        channel: {
          on(eventName, handler) {
            handlers[eventName] = handler;
          },
        },
      },
      addEventListener() {},
      setTimeout,
    };
    try {
      installStorybookSmokeProbe({ storyId: job.storyId });
      handlers.storyFinished({ storyId: job.storyId, status: 'error', error: new Error('boom') });
      assert.deepEqual(globalThis.window.__makaStorybookSmoke.failures, ['storyFinished: boom']);
    } finally {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    }
  });

  it('fails on browser errors and empty content', async () => {
    const pageError = new FakePage((page) => page.emit('pageerror', new Error('render exploded')));
    await assert.rejects(
      () => smokeStory(pageError, 'http://storybook.test', job),
      /render exploded/,
    );

    const empty = new FakePage(undefined, { hasContent: false, failures: [] });
    await assert.rejects(() => smokeStory(empty, 'http://storybook.test', job), /empty content/);
  });
});
