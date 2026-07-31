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
  it('keeps parent and proxy drafts last-write-wins with visible save failures', () => {
    assert.match(
      settingsSource,
      /const ticket = settingsUpdateTicketRef\.current \+ 1;[\s\S]*settingsUpdateTicketRef\.current = ticket;[\s\S]*await window\.maka\.settings\.update\(patch\);[\s\S]*settingsModalMountedRef\.current && ticket === settingsUpdateTicketRef\.current/,
    );
    assert.match(
      networkBlock,
      /useOptimisticSettingsDraft<NetworkProxySettings>\([\s\S]*persistedProxy,[\s\S]*\(patch\) => props\.onUpdate\(\{ network: \{ proxy: patch \} \}\)\.then\(\(result\) => result\.settings\.network\.proxy\)/,
    );
    assert.match(networkBlock, /draftRef: proxyDraftRef,[\s\S]*mountedRef: networkPageMountedRef,[\s\S]*update,/);
    assert.match(
      networkBlock,
      /onError: \(error\) => toast\.error\(copy\.saveNetworkFailed, settingsActionErrorMessage\(error, locale\)\)/,
    );
    assert.match(networkBlock, /onChange=\{\(enabled\) => void updateProxy\(\{ enabled \}\)\}/);
    assert.match(networkBlock, /onChange=\{\(value\) => void updateProxy\(\{ host: value \}\)\}/);
    assert.match(networkBlock, /onChange=\{\(value\) => void updateProxy\(\{ port: value \?\? 0 \}\)\}/);
    assert.match(
      networkBlock,
      /value=\{proxyDraft\.bypassList\.join\(', '\)\}[\s\S]*onChange=\{\(value\) => void updateProxy\(\{ bypassList: csvList\(value\) \}\)\}/,
    );
  });

  it('tests the latest proxy draft once and localizes failures at the IPC boundary', () => {
    const helper = mainSource.match(
      /function proxyTestFailureMessage\(result: TestProxyResult\): string \{[\s\S]*?\n\}/,
    );

    assert.ok(helper, 'main must normalize proxy test failures at the IPC boundary');
    assert.match(helper[0], /proxy disabled[\s\S]*代理未启用，请先打开代理开关/);
    assert.match(helper[0], /proxy host\/port required[\s\S]*请填写代理服务器地址和端口后再测试/);
    assert.match(helper[0], /proxy test timeout[\s\S]*代理测试超时，请检查代理服务是否可达/);
    assert.match(helper[0], /result\.status[\s\S]*代理测试返回 HTTP \$\{result\.status\}/);
    assert.match(helper[0], /redactSecrets\(result\.error \?\? ''\)/);
    assert.match(helper[0], /generalizedErrorMessageChinese\(raw, ''\)/);
    assert.match(mainSource, /message: proxyTestFailureMessage\(result\)/);
    assert.match(networkBlock, /const proxyTestGuard = useActionGuard<'test'>\(\)/);
    assert.match(
      networkBlock,
      /proxyTestGuard\.begin\('test'\)[\s\S]*testNetworkProxy\(toProxyTestInput\(proxyDraftRef\.current\)\)/,
    );
    assert.match(networkBlock, /proxyTestGuard\.finish\(\)/);
    assert.match(networkBlock, /settingsActionErrorMessage\(error, locale\)/);
  });

  it('exposes pending state and drops late proxy-test UI writes after unmount', () => {
    assert.match(networkBlock, /aria-busy=\{testing\}/);
    assert.match(networkBlock, /data-pending=\{testing \? 'true' : undefined\}/);
    assert.match(networkBlock, /onClick=\{\(\) => void testProxy\(\)\}/);
    assert.match(
      networkBlock,
      /if \(result\.ok && networkPageMountedRef\.current\)[\s\S]*else if \(networkPageMountedRef\.current\)/,
    );
    assert.match(
      networkBlock,
      /catch \(error\) \{[\s\S]*if \(networkPageMountedRef\.current\)[\s\S]*settingsActionErrorMessage\(error, locale\)/,
    );
    assert.match(
      networkBlock,
      /finally \{[\s\S]*proxyTestGuard\.finish\(\);[\s\S]*if \(networkPageMountedRef\.current\) \{[\s\S]*setTesting\(false\)/,
    );
  });
});
