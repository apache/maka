import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { BOT_DELIVERY_PROVIDERS, BOT_PROVIDERS } from '@maka/core';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

async function readRepo(path: string): Promise<string> {
  return readFile(resolve(REPO_ROOT, path), 'utf8');
}

/**
 * PR-BOT-RUNTIME-CONSISTENCY-CONTRACT-0
 *
 * A platform that lives in `BOT_LABELS[X].support === 'runtime'` is
 * making two co-dependent promises across two files:
 *
 *   1. `apps/desktop/src/renderer/settings/SettingsModal.tsx`
 *      `BOT_LABELS[X].support === 'runtime'`
 *   2. `packages/runtime/src/bots/bot-registry.ts`
 *      `isImplemented(X) === true`
 *
 * Runtime-labeled platforms must ALSO be listed in
 * `BOT_DELIVERY_PROVIDERS` (`packages/core/src/bot-chat-settings.ts`) so plan
 * reminders can target them. The reverse is NOT required: a platform
 * can be delivery-capable without being `'runtime'` — WeChat is a
 * delivery target via the optional local wechat-bridge, but its
 * end-to-end UX is gated on that external process so its `support`
 * stays `'credentials'`.
 *
 * Pin both lock-steps so a future PR that flips `support` (or adds
 * a new platform) cannot ship without keeping the locations in sync.
 */
describe('Bot runtime / delivery / label cross-source consistency (PR-BOT-RUNTIME-CONSISTENCY-CONTRACT-0)', () => {
  it('every runtime-labeled platform is also implemented in the registry and listed in BOT_DELIVERY_PROVIDERS', async () => {
    const settings = await readSettingsCombinedSource();
    const registry = await readRepo('packages/runtime/src/bots/bot-registry.ts');

    // Extract the BOT_LABELS literal block. We want each platform's
    // `support: 'runtime' | 'credentials' | 'planned'` literal.
    const labelsBlock = settings.match(
      /const BOT_LABELS:[\s\S]*?\r?\n\};\r?\n/,
    );
    assert.ok(labelsBlock, 'BOT_LABELS literal block must exist');

    const runtimePlatforms: string[] = [];
    for (const provider of BOT_PROVIDERS) {
      // Each provider key followed by an object that includes
      // `support: 'X'`. We look ahead within the block.
      const blockSegment = labelsBlock![0].match(
        new RegExp(`${provider}:\\s*\\{[\\s\\S]*?support:\\s*'(runtime|credentials|planned)'`),
      );
      assert.ok(blockSegment, `BOT_LABELS must define ${provider}`);
      if (blockSegment![1] === 'runtime') runtimePlatforms.push(provider);
    }

    // 1) registry.isImplemented must include every runtime platform.
    const implementedFn = registry.match(
      /function isImplemented\([^)]*\): boolean \{[\s\S]*?\r?\n\}\r?\n/,
    );
    assert.ok(implementedFn, 'bot-registry.isImplemented must exist');
    for (const platform of runtimePlatforms) {
      assert.match(
        implementedFn![0],
        new RegExp(`platform === '${platform}'`),
        `runtime platform ${platform} must be wired in bot-registry.isImplemented`,
      );
    }

    // 2) BOT_DELIVERY_PROVIDERS must include every runtime platform.
    // (Runtime platforms are send-capable; plan reminders need this
    // list to surface the platform as a target.)
    for (const platform of runtimePlatforms) {
      assert.equal(
        (BOT_DELIVERY_PROVIDERS as readonly string[]).includes(platform),
        true,
        `runtime platform ${platform} must be listed in BOT_DELIVERY_PROVIDERS so plan reminders can target it`,
      );
    }
  });

  it('current main reflects the expected runtime platform set', async () => {
    // Defense-in-depth: pin the expected list explicitly so a future PR
    // that flips a platform back to credentials-only does not slide by
    // unnoticed. Update this list when a real platform transition lands.
    const settings = await readSettingsCombinedSource();
    const labelsBlock = settings.match(/const BOT_LABELS:[\s\S]*?\r?\n\};\r?\n/)!;

    // WeChat is intentionally NOT in this set: it has a live wechat-bridge
    // adapter and is in BOT_DELIVERY_PROVIDERS, but its `support` stays
    // `'credentials'` because the end-to-end UX requires the user to run
    // an external local bridge process.
    const expectedRuntime = new Set([
      'telegram',
      'discord',
      'dingtalk',
      'qq',
      'slack',
      'whatsapp',
    ]);
    const actualRuntime = new Set<string>();
    for (const provider of BOT_PROVIDERS) {
      const segment = labelsBlock[0].match(
        new RegExp(`${provider}:\\s*\\{[\\s\\S]*?support:\\s*'(runtime|credentials|planned)'`),
      );
      if (segment && segment[1] === 'runtime') actualRuntime.add(provider);
    }

    assert.deepEqual(
      [...actualRuntime].sort(),
      [...expectedRuntime].sort(),
      'runtime platform set drifted — update either BOT_LABELS or the expected pin if this was intentional',
    );
  });
});
