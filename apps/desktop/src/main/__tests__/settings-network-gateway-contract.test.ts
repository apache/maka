import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readSettingsCombinedSourceSync } from './settings-contract-source-helpers.js';
import { readMainProcessCombinedSourceSync } from './main-process-contract-source-helpers.js';

const settingsSource = readSettingsCombinedSourceSync();
const mainSource = readMainProcessCombinedSourceSync();

function blockBetween(start: string, end: string): string {
  return settingsSource.match(new RegExp(`${start}[\\s\\S]*?${end}`))?.[0] ?? '';
}

describe('Settings network and gateway persistence contract', () => {
  it('ignores stale settings save responses after newer field edits', () => {
    assert.match(
      settingsSource,
      /const settingsUpdateTicketRef = useRef\(0\)/,
      'Settings updates need a latest-response ticket so rapid field edits cannot be overwritten by an older save response',
    );
    assert.match(
      settingsSource,
      /async function updateSettings\(patch: Parameters<typeof window\.maka\.settings\.update>\[0\]\) \{[\s\S]*const ticket = settingsUpdateTicketRef\.current \+ 1;[\s\S]*settingsUpdateTicketRef\.current = ticket;[\s\S]*const result = await window\.maka\.settings\.update\(patch\);[\s\S]*if \(settingsModalMountedRef\.current && ticket === settingsUpdateTicketRef\.current\) \{[\s\S]*setSettings\(next\);[\s\S]*props\.onUserLabelChange\?\.\(next\.personalization\.displayName\);[\s\S]*\}/,
      'Settings update responses should only refresh parent state when they belong to the latest save and the modal is still mounted',
    );
  });

  it('surfaces network proxy save failures instead of returning raw rejected promises from field handlers', () => {
    const networkBlock = blockBetween('function NetworkProxySection', 'function OpenGatewaySettingsPage');

    assert.match(
      networkBlock,
      /useOptimisticSettingsDraft<NetworkProxySettings>\([\s\S]*persistedProxy,[\s\S]*\(patch\) => props\.onUpdate\(\{ network: \{ proxy: patch \} \}\)\.then\(\(result\) => result\.settings\.network\.proxy\)/,
      'Network proxy must drive its local draft through the shared optimistic draft hook so typing does not wait for IPC',
    );
    assert.match(
      networkBlock,
      /draft: proxyDraft,[\s\S]*draftRef: proxyDraftRef,[\s\S]*mountedRef: networkPageMountedRef,[\s\S]*update,/,
      'Network proxy must read its rendered draft, synchronous draft ref, and mounted ref from the shared hook',
    );
    assert.match(
      networkBlock,
      /\{ onError: \(error\) => toast\.error\(copy\.saveNetworkFailed, settingsActionErrorMessage\(error, locale\)\) \},[\s\S]*function updateProxy\(patch: Partial<NetworkProxySettings>\) \{[\s\S]*return update\(patch\);/,
      'Network proxy field saves must route through the shared draft update and surface a visible failure toast',
    );
    assert.match(
      networkBlock,
      /value=\{proxyDraft\.host\}[\s\S]*onChange=\{\(value\) => void updateProxy\(\{ host: value \}\)\}/,
      'Network proxy host input must render from the local draft while persisting in the background',
    );
    assert.match(
      networkBlock,
      /value=\{proxyDraft\.port \|\| null\}[\s\S]*onChange=\{\(value\) => void updateProxy\(\{ port: value \?\? 0 \}\)\}/,
      'Network proxy port input must render from the local draft while persisting in the background',
    );
    assert.match(
      networkBlock,
      /value=\{proxyDraft\.bypassList\.join\(', '\)\}[\s\S]*onChange=\{\(value\) => void updateProxy\(\{ bypassList: csvList\(value\) \}\)\}/,
      'Network proxy bypass-list input must render from the local draft while persisting in the background',
    );
    assert.doesNotMatch(
      networkBlock,
      /onChange=\{\([^)]*\) => updateProxy\(/,
      'Network proxy field handlers must not leak a returned rejected promise',
    );
    assert.match(
      networkBlock,
      /onChange=\{\(enabled\) => void updateProxy\(\{ enabled \}\)\}/,
      'Network proxy enable switch should explicitly fire-and-report via updateProxy',
    );
  });

  it('localizes proxy test failure messages before returning them to Settings', () => {
    const helper = mainSource.match(/function proxyTestFailureMessage\(result: TestProxyResult\): string \{[\s\S]*?\n\}/);
    const handler = mainSource.match(/settings:testNetworkProxy[\s\S]*?satisfies SettingsTestResult;/)?.[0] ?? '';
    const networkBlock = blockBetween('function NetworkProxySection', 'function OpenGatewaySettingsPage');

    assert.ok(helper, 'main must normalize proxy test failures at the IPC boundary');
    assert.match(helper![0], /proxy disabled[\s\S]*代理未启用，请先打开代理开关/);
    assert.match(helper![0], /proxy host\/port required[\s\S]*请填写代理服务器地址和端口后再测试/);
    assert.match(helper![0], /proxy test timeout[\s\S]*代理测试超时，请检查代理服务是否可达/);
    assert.match(helper![0], /result\.status[\s\S]*代理测试返回 HTTP \$\{result\.status\}/);
    assert.match(helper![0], /redactSecrets\(result\.error \?\? ''\)/);
    assert.match(helper![0], /generalizedErrorMessageChinese\(raw, ''\)/);
    assert.match(handler, /message: proxyTestFailureMessage\(result\)/);
    assert.doesNotMatch(
      handler,
      /message: result\.error \?\? \(result\.status \? `HTTP \$\{result\.status\}` : '代理不可达'\)/,
      'proxy test IPC must not pass through runtime English/raw failure messages',
    );
    assert.match(
      networkBlock,
      /catch \(error\) \{[\s\S]*toast\.error\(copy\.proxyTestError, settingsActionErrorMessage\(error, locale\)\)/,
      'Renderer-side proxy test IPC rejections must use the Settings error scrubber',
    );
    assert.doesNotMatch(
      networkBlock,
      /代理测试出错[\s\S]{0,120}error instanceof Error \? error\.message : String\(error\)/,
      'Renderer-side proxy test must not toast raw Error.message on rejected IPC',
    );
  });

  it('gates proxy tests and reads the latest draft snapshot', () => {
    const networkBlock = blockBetween('function NetworkProxySection', 'function OpenGatewaySettingsPage');

    assert.match(
      networkBlock,
      /const proxyTestGuard = useActionGuard<'test'>\(\)/,
      'Network proxy test needs a synchronous guard so fast double-clicks cannot duplicate proxy test IPC before React disables the button',
    );
    assert.match(
      networkBlock,
      /async function testProxy\(\) \{\s*if \(!proxyTestGuard\.begin\('test'\)\) return;[\s\S]*window\.maka\.settings\.testNetworkProxy\(toProxyTestInput\(proxyDraftRef\.current\)\)/,
      'Network proxy test must lock synchronously and test the latest local draft snapshot, not the previous render value',
    );
    assert.match(
      networkBlock,
      /finally \{[\s\S]*proxyTestGuard\.finish\(\);[\s\S]*setTesting\(false\);[\s\S]*\}/,
      'Network proxy test must release the guard after the IPC settles',
    );
    assert.doesNotMatch(
      networkBlock,
      /testNetworkProxy\(toProxyTestInput\(proxyDraft\)\)/,
      'Network proxy test must not read stale React state after a just-typed proxy edit',
    );
    assert.match(networkBlock, /aria-busy=\{testing\}/, 'Network proxy test button must expose pending state to assistive tech');
    assert.match(networkBlock, /data-pending=\{testing \? 'true' : undefined\}/, 'Network proxy test button must expose a stable pending hook');
    assert.match(networkBlock, /onClick=\{\(\) => void testProxy\(\)\}/, 'Network proxy test click handler must explicitly discard the async promise');
  });

  it('drops late network proxy save and test UI writes after Settings is closed', () => {
    const networkBlock = blockBetween('function NetworkProxySection', 'function OpenGatewaySettingsPage');

    assert.match(
      networkBlock,
      /mountedRef: networkPageMountedRef,/,
      'Network proxy page must track mounted ownership (from the shared draft hook) for async save/test actions',
    );
    assert.match(
      networkBlock,
      /const proxyTestGuard = useActionGuard<'test'>\(\)/,
      'Network proxy test ownership must come from the shared action-guard hook (released on unmount; the draft hook invalidates save tickets)',
    );
    // Save-response staleness + rollback after unmount are owned by the shared
    // optimistic draft hook and covered by its controller unit test; the page
    // only wires the failure toast through the hook-level onError callback.
    assert.match(
      networkBlock,
      /if \(result\.ok && networkPageMountedRef\.current\) \{[\s\S]*toast\.success\(copy\.proxyReachable/,
      'Network proxy test success toast must only fire while the page is still mounted',
    );
    assert.match(
      networkBlock,
      /else if \(networkPageMountedRef\.current\) \{[\s\S]*toast\.error\(copy\.proxyTestFailed, result\.message\);/,
      'Network proxy test failure toast must only fire while the page is still mounted',
    );
    assert.match(
      networkBlock,
      /catch \(error\) \{[\s\S]*if \(networkPageMountedRef\.current\) \{[\s\S]*toast\.error\(copy\.proxyTestError, settingsActionErrorMessage\(error, locale\)\);/,
      'Network proxy test thrown-error toast must only fire while the page is still mounted',
    );
    assert.match(
      networkBlock,
      /finally \{[\s\S]*proxyTestGuard\.finish\(\);[\s\S]*if \(networkPageMountedRef\.current\) \{[\s\S]*setTesting\(false\);/,
      'Network proxy test cleanup must release the guard but not write React state after unmount',
    );
  });

  it('keeps gateway success toasts behind a successful settings save', () => {
    const gatewayBlock = blockBetween('function OpenGatewaySettingsPage', 'function presentGatewayStatus');

    assert.match(
      gatewayBlock,
      /useOptimisticSettingsDraft<AppSettings\['openGateway'\]>\([\s\S]*persistedGateway,[\s\S]*\(patch\) => props\.onUpdate\(\{ openGateway: patch \}\)\.then\(\(result\) => result\.settings\.openGateway\)/,
      'Open Gateway host/port controls must use the shared optimistic draft hook so typing does not wait for IPC persistence',
    );
    assert.match(
      gatewayBlock,
      /draft: gatewayDraft,[\s\S]*mountedRef: openGatewayMountedRef,[\s\S]*update,/,
      'Open Gateway must read its rendered draft and mounted ref from the shared hook',
    );
    assert.match(
      gatewayBlock,
      /onReconcile: \(next\) => setTokenDraft\(next\.token\)/,
      'Open Gateway must keep the token draft mirrored when the persisted value syncs in',
    );
    assert.match(
      gatewayBlock,
      /<div className="settingsGatewaySummary" role="group" aria-label=\{copy\.summary\.aria\}>/,
      'Open Gateway runtime metric cards must expose an accessible group name',
    );
    assert.match(
      gatewayBlock,
      /<div className="settingsActionRow" role="group" aria-label=\{copy\.actions\.aria\}>/,
      'Open Gateway token and curl actions must expose an accessible group name',
    );
    assert.doesNotMatch(
      gatewayBlock,
      /<div className="settingsGatewaySummary" aria-label=\{copy\.summary\.aria\}>/,
      'Open Gateway runtime metrics must not regress to an anonymous status summary',
    );
    assert.doesNotMatch(
      gatewayBlock,
      /<div className="settingsActionRow">\s*<button className="maka-button" type="button" disabled=\{saving\} onClick=\{\(\) => void generateToken\(\)\}>/,
      'Open Gateway action row must not regress to an anonymous button cluster',
    );
    assert.match(
      gatewayBlock,
      /onError: \(error\) => toast\.error\(copy\.errors\.save, settingsActionErrorMessage\(error, locale\)\),[\s\S]*onReconcile: \(next\) => setTokenDraft\(next\.token\),[\s\S]*function updateGateway\(patch: Partial<AppSettings\['openGateway'\]>\): Promise<boolean> \{[\s\S]*return update\(patch\);/,
      'Open Gateway settings updates must return the shared update result, mirror authoritative tokens, and surface failures',
    );
    assert.match(
      gatewayBlock,
      /<Selector[\s\S]*value=\{gatewayDraft\.host\}[\s\S]*label=\{copy\.form\.host\}[\s\S]*onChange=\{\(host\) => void updateGateway\(\{ host: host as AppSettings\['openGateway'\]\['host'\] \}\)\}/,
      'Open Gateway host select must render from the local draft while persisting in the background',
    );
    assert.match(
      gatewayBlock,
      /value=\{gatewayDraft\.port\}[\s\S]*onChange=\{\(value\) => void updateGateway\(\{ port: value \?\? 3939 \}\)\}/,
      'Open Gateway port input must render from the local draft while persisting in the background',
    );
    assert.doesNotMatch(
      gatewayBlock,
      /<NumberInput label=\{copy\.form\.port\}[\s\S]{0,240}isDisabled=\{saving\}/,
      'Open Gateway port input must not lock after each digit while background save is pending',
    );
    assert.match(
      gatewayBlock,
      /const saved = await updateGateway\(\{ token: nextToken \}\);[\s\S]*if \(!saved \|\| !openGatewayMountedRef\.current\) return;[\s\S]*toast\.success\(nextToken \? copy\.toast\.tokenSaved : copy\.toast\.tokenCleared\)/,
      'Saving or clearing the gateway token must not show success after a failed save',
    );
    assert.match(
      gatewayBlock,
      /const saved = await updateGateway\(\{ token \}\);[\s\S]*if \(!saved \|\| !openGatewayMountedRef\.current\) return;[\s\S]*toast\.success\(copy\.toast\.tokenGenerated/,
      'Generated gateway tokens must not show success after a failed save',
    );
    assert.doesNotMatch(
      gatewayBlock,
      /onChange=\{\([^)]*\) => updateGateway\(/,
      'Open Gateway field handlers must not leak a returned rejected promise',
    );
  });

  it('drops late Open Gateway save and copy UI writes after Settings is closed', () => {
    const gatewayBlock = blockBetween('function OpenGatewaySettingsPage', 'function presentGatewayStatus');

    assert.match(
      gatewayBlock,
      /mountedRef: openGatewayMountedRef,/,
      'Open Gateway page must track mounted ownership (from the shared draft hook) for async save/copy actions',
    );
    assert.match(
      gatewayBlock,
      /const gatewayCopyGuard = useActionGuard<string>\(\)/,
      'Open Gateway copy ownership must come from the shared action-guard hook (released on unmount; the draft hook invalidates save tickets)',
    );
    // Save-response staleness, draft rollback, token mirroring, and pending
    // state are owned by the shared optimistic draft hook (unit-tested on its
    // controller). The page reads the hook-owned saving state.
    assert.match(
      gatewayBlock,
      /mountedRef: openGatewayMountedRef,[\s\S]*saving,[\s\S]*update,/,
      'Open Gateway pending state must come from the shared hook',
    );
    assert.doesNotMatch(
      gatewayBlock,
      /const \[saving, setSaving\] = useState\(false\)/,
      'Open Gateway must not maintain a second pending-state implementation',
    );
    assert.match(
      gatewayBlock,
      /const saved = await updateGateway\(\{ token: nextToken \}\);[\s\S]*if \(!saved \|\| !openGatewayMountedRef\.current\) return;[\s\S]*toast\.success\(nextToken \? copy\.toast\.tokenSaved/,
      'Open Gateway token save success toast must only fire while the page is still mounted',
    );
    assert.match(
      gatewayBlock,
      /const saved = await updateGateway\(\{ token \}\);[\s\S]*if \(!saved \|\| !openGatewayMountedRef\.current\) return;[\s\S]*toast\.success\(copy\.toast\.tokenGenerated/,
      'Open Gateway token generate success toast must only fire while the page is still mounted',
    );
  });

  it('renders gateway runtime start errors from closed reasons instead of raw listen errors', () => {
    const helper = blockBetween('function gatewayErrorCopy', 'function generateGatewayToken');

    assert.match(helper, /error === 'start_failed'/);
    assert.match(helper, /error === 'start_failed'[\s\S]*return copy\.errors\.start/);
    assert.match(helper, /EADDRINUSE[\s\S]*copy\.errors\.portInUse/);
    assert.doesNotMatch(
      helper,
      /return error;/,
      'Open Gateway Settings must not render raw runtime lastError strings',
    );
  });
});
