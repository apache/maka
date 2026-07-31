import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readSettingsCombinedSourceSync } from './settings-contract-source-helpers.js';
import { readMainProcessCombinedSourceSync } from './main-process-contract-source-helpers.js';

const settingsSource = readSettingsCombinedSourceSync();
const mainSource = readMainProcessCombinedSourceSync();
const networkBlock = settingsSource.match(
  /function NetworkProxySection[\s\S]*?export function BotChatSettingsPage/,
)?.[0] ?? '';

describe('Settings network persistence contract', () => {
  it('keeps proxy edits responsive while persisting through the shared draft owner', () => {
    assert.match(
      networkBlock,
      /useOptimisticSettingsDraft<NetworkProxySettings>\([\s\S]*persistedProxy,[\s\S]*\(patch\) => props\.onUpdate\(\{ network: \{ proxy: patch \} \}\)\.then\(\(result\) => result\.settings\.network\.proxy\)/,
    );
    assert.match(networkBlock, /draftRef: proxyDraftRef,[\s\S]*mountedRef: networkPageMountedRef,[\s\S]*update,/);
    assert.match(networkBlock, /onChange=\{\(value\) => void updateProxy\(\{ host: value \}\)\}/);
    assert.match(networkBlock, /onChange=\{\(value\) => void updateProxy\(\{ port: value \?\? 0 \}\)\}/);
  });

  it('tests the latest proxy draft once and localizes failures at the IPC boundary', () => {
    const helper = mainSource.match(
      /function proxyTestFailureMessage\(result: TestProxyResult\): string \{[\s\S]*?\n\}/,
    );

    assert.ok(helper, 'main must normalize proxy test failures at the IPC boundary');
    assert.match(helper[0], /proxy test timeout[\s\S]*代理测试超时，请检查代理服务是否可达/);
    assert.match(helper[0], /redactSecrets\(result\.error \?\? ''\)/);
    assert.match(networkBlock, /const proxyTestGuard = useActionGuard<'test'>\(\)/);
    assert.match(
      networkBlock,
      /proxyTestGuard\.begin\('test'\)[\s\S]*testNetworkProxy\(toProxyTestInput\(proxyDraftRef\.current\)\)/,
    );
    assert.match(networkBlock, /proxyTestGuard\.finish\(\)/);
    assert.match(networkBlock, /settingsActionErrorMessage\(error, locale\)/);
  });
});
