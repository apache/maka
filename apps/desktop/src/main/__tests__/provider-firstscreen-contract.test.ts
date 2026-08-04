import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderType } from '@maka/core';
import { providerDisplay } from '../../renderer/settings/provider-display-copy.js';

test('unknown providers use their persisted type and generic local copy', () => {
  assert.deepEqual(providerDisplay('future-provider' as ProviderType, 'en'), {
    name: 'future-provider',
    description: 'This provider is not registered in the current build.',
  });
});
