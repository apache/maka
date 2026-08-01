import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import {
  PRODUCT_VIEWPORTS,
  installStorybookSmokeProbe,
  smokeStory,
  validateCoverageManifest,
} from './storybook-visual-smoke.mjs';

const storyIds = {
  settings: 'product-settings-pages--general',
  skills: 'product-module-hubs--extensions-skills',
  mcp: 'product-module-hubs--extensions-mcp',
  planReminders: 'product-module-hubs--scheduled-plan-reminders',
  dailyReview: 'product-module-hubs--scheduled-daily-review',
};

function validManifest() {
  return {
    version: 1,
    viewports: PRODUCT_VIEWPORTS,
    surfaces: Object.fromEntries(
      Object.entries(storyIds).map(([surface, storyId]) => [
        surface,
        {
          storyId,
          productionHost: surface === 'settings' ? 'SettingsSurface' : 'AppShellDetailPanel',
          state: 'reachable baseline',
          viewports: Object.keys(PRODUCT_VIEWPORTS),
        },
      ]),
    ),
  };
}

const storyIndex = {
  entries: Object.fromEntries(Object.values(storyIds).map((id) => [id, { id, type: 'story' }])),
};

describe('Product Storybook manifest', () => {
  it('expands every required surface and rejects incomplete or unknown coverage', () => {
    const manifest = validManifest();
    assert.equal(validateCoverageManifest(manifest, storyIndex).length, 15);

    delete manifest.surfaces.skills;
    assert.throws(() => validateCoverageManifest(manifest, storyIndex), /missing required surface/);

    const unknownCheck = validManifest();
    unknownCheck.surfaces.planReminders.checks = ['misspelled-check'];
    assert.throws(() => validateCoverageManifest(unknownCheck, storyIndex), /unknown check/);
  });
});

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
  storyId: storyIds.skills,
  viewport: 'floor',
  size: PRODUCT_VIEWPORTS.floor,
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
