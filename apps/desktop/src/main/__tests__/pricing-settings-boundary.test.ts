import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const PANEL = new URL('../../../src/renderer/settings/pricing-settings-panel.tsx', import.meta.url);
const SURFACE = new URL('../../../src/renderer/settings/settings-surface.tsx', import.meta.url);

test('Pricing renderer stays behind the semantic adapter and away from legacy authorities', async () => {
  const source = await readFile(PANEL, 'utf8');

  assert.match(source, /DesktopPricingSettingsPort/);
  assert.doesNotMatch(source, /window\.maka\.usage/);
  assert.doesNotMatch(source, /usage:pricing:(?:list|put|reset)/);
  assert.doesNotMatch(source, /@maka\/storage/);
  assert.doesNotMatch(source, /runtime-host-client/);
});

test('production SettingsSurface keeps Pricing activation as an optional injection', async () => {
  const source = await readFile(SURFACE, 'utf8');

  assert.match(source, /pricingPort\?: DesktopPricingSettingsPort/);
  assert.doesNotMatch(source, /window\.maka\.(?:usage|runtimeHost).*pricing/i);
});
