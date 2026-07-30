import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  REQUIRED_PRODUCT_SURFACES,
  PRODUCT_VIEWPORTS,
  installStorybookSmokeProbe,
  smokeStory,
  validateCoverageManifest,
} from './storybook-visual-smoke.mjs';

const STORY_INDEX = {
  entries: {
    'product-settings-pages--general': { id: 'product-settings-pages--general', type: 'story' },
    'product-settings-pages--permission-center-diagnostics-expanded': {
      id: 'product-settings-pages--permission-center-diagnostics-expanded',
      type: 'story',
    },
    'product-module-hubs--extensions-skills': {
      id: 'product-module-hubs--extensions-skills',
      type: 'story',
    },
    'product-module-hubs--extensions-skills-installed': {
      id: 'product-module-hubs--extensions-skills-installed',
      type: 'story',
    },
    'product-module-hubs--extensions-mcp': {
      id: 'product-module-hubs--extensions-mcp',
      type: 'story',
    },
    'product-module-hubs--scheduled-plan-reminders': {
      id: 'product-module-hubs--scheduled-plan-reminders',
      type: 'story',
    },
    'product-module-hubs--scheduled-plan-reminders-configured': {
      id: 'product-module-hubs--scheduled-plan-reminders-configured',
      type: 'story',
    },
    'product-module-hubs--scheduled-plan-reminders-attention': {
      id: 'product-module-hubs--scheduled-plan-reminders-attention',
      type: 'story',
    },
    'product-module-hubs--scheduled-plan-reminders-keep-awake': {
      id: 'product-module-hubs--scheduled-plan-reminders-keep-awake',
      type: 'story',
    },
    'product-module-hubs--scheduled-plan-reminders-long-content': {
      id: 'product-module-hubs--scheduled-plan-reminders-long-content',
      type: 'story',
    },
    'product-module-hubs--scheduled-daily-review': {
      id: 'product-module-hubs--scheduled-daily-review',
      type: 'story',
    },
  },
};

function validManifest() {
  return {
    version: 1,
    viewports: PRODUCT_VIEWPORTS,
    surfaces: Object.fromEntries(
      Object.entries({
        settings: 'product-settings-pages--general',
        skills: 'product-module-hubs--extensions-skills',
        mcp: 'product-module-hubs--extensions-mcp',
        planReminders: 'product-module-hubs--scheduled-plan-reminders',
        dailyReview: 'product-module-hubs--scheduled-daily-review',
      }).map(([surface, storyId]) => [
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

describe('Product Storybook coverage manifest', () => {
  it('rejects a missing required surface entry', () => {
    const manifest = validManifest();
    delete manifest.surfaces.skills;

    assert.throws(
      () => validateCoverageManifest(manifest, STORY_INDEX),
      /missing required surface: skills/,
    );
  });

  it('rejects an unknown story id', () => {
    const manifest = validManifest();
    manifest.surfaces.mcp.storyId = 'product-module-hubs--missing';

    assert.throws(
      () => validateCoverageManifest(manifest, STORY_INDEX),
      /unknown story id: product-module-hubs--missing/,
    );
  });

  it('rejects an extra manifest entry with an unknown story id', () => {
    const manifest = validManifest();
    manifest.surfaces.extra = {
      storyId: 'product-extra--missing',
      productionHost: 'ExtraPage',
      state: 'extra baseline',
      viewports: ['wide', 'compact', 'floor'],
    };

    assert.throws(
      () => validateCoverageManifest(manifest, STORY_INDEX),
      /unknown story id: product-extra--missing/,
    );
  });

  it('rejects unknown browser checks instead of silently skipping them', () => {
    const manifest = validManifest();
    manifest.surfaces.planReminders.checks = ['plan-remidner-row'];

    assert.throws(
      () => validateCoverageManifest(manifest, STORY_INDEX),
      /planReminders uses unknown check: plan-remidner-row/,
    );
  });

  it('executes every extra manifest entry instead of silently ignoring it', () => {
    const manifest = validManifest();
    manifest.surfaces.extra = {
      storyId: 'product-module-hubs--extensions-skills',
      productionHost: 'AppShellDetailPanel',
      state: 'extra reachable state',
      viewports: ['wide', 'compact', 'floor'],
    };

    const jobs = validateCoverageManifest(manifest, STORY_INDEX);

    assert.equal(jobs.length, 18);
    assert.equal(jobs.filter((job) => job.surface === 'extra').length, 3);
  });

  it('expands every required surface across real named viewports', () => {
    const jobs = validateCoverageManifest(validManifest(), STORY_INDEX);

    assert.equal(jobs.length, REQUIRED_PRODUCT_SURFACES.length * 3);
    assert.deepEqual([...new Set(jobs.map((job) => job.viewport))], ['wide', 'compact', 'floor']);
    assert.deepEqual(PRODUCT_VIEWPORTS, {
      wide: { width: 1280, height: 900 },
      compact: { width: 820, height: 900 },
      floor: { width: 480, height: 900 },
    });
  });

  it('keeps the checked-in manifest complete', async () => {
    const manifest = JSON.parse(
      await readFile('apps/desktop/stories/product-smoke-manifest.json', 'utf8'),
    );

    const jobs = validateCoverageManifest(manifest, STORY_INDEX);
    assert.equal(jobs.length, 26);
    assert.deepEqual(
      jobs
        .filter((job) => job.surface === 'planReminders')
        .map(({ viewport, colorScheme, checks }) => ({ viewport, colorScheme, checks })),
      [
        { viewport: 'wide', colorScheme: 'light', checks: ['plan-reminder-row'] },
        { viewport: 'wide', colorScheme: 'dark', checks: ['plan-reminder-row'] },
        { viewport: 'compact', colorScheme: 'light', checks: ['plan-reminder-row'] },
        { viewport: 'compact', colorScheme: 'dark', checks: ['plan-reminder-row'] },
        { viewport: 'floor', colorScheme: 'light', checks: ['plan-reminder-row'] },
        { viewport: 'floor', colorScheme: 'dark', checks: ['plan-reminder-row'] },
      ],
    );
    assert.deepEqual(
      [
        ...new Set(
          jobs.filter((job) => job.surface.startsWith('planReminders')).map((job) => job.surface),
        ),
      ],
      [
        'planReminders',
        'planRemindersEmpty',
        'planRemindersAttention',
        'planRemindersKeepAwake',
        'planRemindersLongContent',
      ],
    );
    const narrowJobs = jobs.filter(
      (job) => job.surface === 'planRemindersLongContent' && job.viewport === 'floor',
    );
    assert.equal(narrowJobs.length, 2);
    assert.ok(narrowJobs.every((job) => job.size.width === 480 && job.size.height === 720));
  });
});

class FakePage extends EventEmitter {
  constructor(onGoto, evaluation = true) {
    super();
    this.onGoto = onGoto;
    this.evaluation = evaluation;
  }

  async addInitScript() {}

  async setViewportSize(viewport) {
    this.viewport = viewport;
  }

  async goto() {
    this.onGoto?.(this);
  }

  async waitForFunction() {}

  async evaluate() {
    return this.evaluation;
  }
}

const JOB = {
  surface: 'skills',
  storyId: 'product-module-hubs--extensions-skills',
  viewport: 'floor',
  size: PRODUCT_VIEWPORTS.floor,
};

describe('Product Storybook browser smoke', () => {
  it('treats Storybook 10 storyFinished error status as a failure', () => {
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
      installStorybookSmokeProbe({ storyId: JOB.storyId });
      handlers.storyFinished({
        storyId: JOB.storyId,
        status: 'error',
        error: new Error('play failed'),
      });

      assert.deepEqual(globalThis.window.__makaStorybookSmoke.failures, [
        'storyFinished: play failed',
      ]);
    } finally {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    }
  });

  it('reports a render exception with story id and viewport', async () => {
    const page = new FakePage((current) => {
      current.emit('pageerror', new Error('render exploded'));
    });

    await assert.rejects(
      smokeStory(page, 'http://storybook.test', JOB),
      /\[product-module-hubs--extensions-skills @ floor\].*render exploded/,
    );
  });

  it('reports console.error with story id and viewport', async () => {
    const page = new FakePage((current) => {
      current.emit('console', {
        type: () => 'error',
        text: () => 'story logged an error',
      });
    });

    await assert.rejects(
      smokeStory(page, 'http://storybook.test', JOB),
      /\[product-module-hubs--extensions-skills @ floor\].*story logged an error/,
    );
  });

  it('rejects an empty story root', async () => {
    const page = new FakePage(undefined, { hasContent: false, failures: [] });

    await assert.rejects(
      smokeStory(page, 'http://storybook.test', JOB),
      /\[product-module-hubs--extensions-skills @ floor\].*empty content/,
    );
  });

  it('rejects an unhandled promise rejection captured in the iframe', async () => {
    const page = new FakePage(undefined, {
      hasContent: true,
      failures: ['unhandled rejection: async exploded'],
    });

    await assert.rejects(
      smokeStory(page, 'http://storybook.test', JOB),
      /\[product-module-hubs--extensions-skills @ floor\].*unhandled rejection: async exploded/,
    );
  });
});
