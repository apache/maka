import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

const ROOT = resolve(process.cwd(), '..', '..');

describe('Desktop Computer Use production wiring', () => {
  it('registers the function harness without presentation or provider adapters', async () => {
    const [main, catalog] = await Promise.all([
      readMainProcessCombinedSource(),
      readFile(resolve(ROOT, 'packages/core/src/tool-catalog.ts'), 'utf8'),
    ]);
    assert.match(main, /createComputerUseHost/);
    assert.match(main, /createCursorOverlayController/);
    assert.match(main, /createComputerUseOverlayHook/);
    assert.match(main, /computerUseTools/);
    // Deferred group identity lives in the shared catalog; desktop derives it.
    assert.match(catalog, /id:\s*'computer_use'/);
    assert.match(main, /projectEffectiveProductToolSurface\(\{[\s\S]*host:\s*'desktop'/);
    assert.doesNotMatch(main, /createAnthropicComputerHarness|createKimiComputerHarness|createMiniMaxComputerHarness/);
  });

  it('clears Runtime and executor ownership at every turn/session boundary', async () => {
    const main = await readMainProcessCombinedSource();
    assert.match(main, /sessions:stop[\s\S]*computerUseTools\.clearSession/);
    assert.match(main, /sessions:stop[\s\S]*computerUseOverlay\.clearForSession/);
    assert.match(main, /sessions:archive[\s\S]*computerUseTools\.clearSession/);
    assert.match(main, /sessions:archive[\s\S]*computerUseOverlay\.clearForSession/);
    assert.match(main, /const removeSession[\s\S]*computerUseTools\.clearSession/);
    assert.match(main, /const removeSession[\s\S]*computerUseOverlay\.clearForSession/);
    assert.match(main, /sessions:remove[\s\S]*await removeSession/);
    assert.match(main, /isTurnStatusChangingSessionEvent[\s\S]*computerUseTools\.clearSession/);
    assert.match(main, /catch \(error\)[\s\S]*computerUseTools\.clearSession/);
    assert.match(main, /Promise\.allSettled\(\[[\s\S]*computerUse\.backend\?\.dispose/);
    assert.match(main, /Promise\.allSettled\(\[[\s\S]*computerUseOverlay\.destroyAll/);
    assert.match(main, /window-all-closed[\s\S]*computerUseOverlay\.destroyAll/);
    assert.match(main, /onMainWindowClose = \(\) => computerUseOverlay\.destroyAll/);
  });

  it('reports scoped approval and live service health instead of binary-only healthy', async () => {
    const [snapshot, main] = await Promise.all([
      readFile(resolve(ROOT, 'apps/desktop/src/main/capability-snapshot.ts'), 'utf8'),
      readMainProcessCombinedSource(),
    ]);
    const capability = snapshot.match(
      /function computerUseCapability[\s\S]*?(?=function staticCapability)/,
    )?.[0];
    assert.ok(capability, 'Computer Use capability block must exist');
    assert.match(capability, /required_scoped_lease/);
    assert.match(capability, /input\?\.health\.state/);
    assert.match(capability, /未找到通过完整性检查的 cua-driver artifact/);
    assert.match(capability, /等待.*权限/);
    assert.match(capability, /service 正在启动或恢复/);
    assert.match(capability, /service 启动失败、已退出或已停止/);
    assert.doesNotMatch(capability, /required_per_action/);
    assert.match(main, /computerUse\.backend\?\.serviceState/);
    assert.match(main, /computerUseServiceHealth/);
  });

  it('does not expose screenshot-returning Computer Use tools to non-visual models', async () => {
    const [main, packageJson] = await Promise.all([
      readMainProcessCombinedSource(),
      readFile(resolve(ROOT, 'apps/desktop/package.json'), 'utf8'),
    ]);
    assert.match(main, /computerUseToolsForModel\([\s\S]*supportsVision/);
    assert.match(main, /projectEffectiveProductToolSurface\(\{[\s\S]*tools:\s*selectedTools/);
    assert.match(
      packageJson,
      /"smoke:browser":\s*"[^"]*@maka\/computer-use[^"]*build:main/,
    );
  });

  it('wires a conservative physical-input quiet window', async () => {
    const main = await readMainProcessCombinedSource();
    assert.match(main, /powerMonitor\.getSystemIdleTime\(\) < 1/);
    assert.match(main, /physicalInputRecentlyActive/);
  });
});
