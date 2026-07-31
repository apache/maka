import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join, resolve } from 'node:path';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';
import { getPermissionCenterCopy } from '../../renderer/locales/permission-center-copy.js';
import { getVoiceSettingsCopy } from '../../renderer/locales/settings-voice-copy.js';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const CAPABILITY_SNAPSHOT = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'capability-snapshot.ts');

describe('voice capture smoke Settings contract', () => {
  it('does not present voice models as a coming-soon nav item', async () => {
    // PR-VOICE-GATEWAY-SPLIT-0 (WAWQAQ msg `d3ea9a33` 2026-06-26):
    // 语音 and 开放网关 are now separate nav items (voice + open-
    // gateway). Both pages stay first-class — neither is coming-soon.
    const src = await readSettingsCombinedSource();
    const voiceNav = src.match(/\{\s*id:\s*'voice'[\s\S]*?\},/);
    assert.ok(voiceNav, 'voice nav item must exist');
    assert.doesNotMatch(voiceNav![0], /comingSoon:\s*true/, 'voice nav must not be tagged as coming soon');
    const gatewayNav = src.match(/\{\s*id:\s*'open-gateway'[\s\S]*?\},/);
    assert.ok(gatewayNav, 'open-gateway nav item must exist');
    assert.doesNotMatch(gatewayNav![0], /comingSoon:\s*true/, 'open-gateway nav must not be tagged as coming soon');
    assert.match(src, /case\s+'voice':\s*\n[\s\S]*?<VoiceModelsSettingsPage\b/);
    assert.match(src, /case\s+'open-gateway':\s*\n[\s\S]*?<OpenGatewaySettingsPage\b/);
    assert.doesNotMatch(src, /'voice':\s*\{[\s\S]*当前尚未实现/, 'voice must not keep stale roadmap copy');
  });

  it('runs only a local renderer capture smoke and validates it through the core voice contract', async () => {
    const src = await readSettingsCombinedSource();
    const zhCopy = getVoiceSettingsCopy('zh');
    assert.match(src, /navigator\.mediaDevices\.getUserMedia/, 'voice page must request local microphone capture');
    assert.match(src, /new MediaRecorder\(stream\)/, 'voice page must use MediaRecorder for local smoke');
    assert.match(src, /validateVoiceCaptureRequest/, 'voice page must validate capture facts through @maka/core/voice');
    assert.match(src, /copy\.available\(formatVoiceDuration/, 'voice result must use the active locale catalog');
    assert.match(zhCopy.available('1.0 秒', '1 MB'), /样本未保存/, 'voice page must tell users that the sample is not saved');
    assert.match(zhCopy.idle, /等待运行本机录音自检/, 'voice idle state should read as an actionable local check');
    assert.doesNotMatch(zhCopy.idle, /尚未运行本机录音自检/, 'voice idle state should not read like unfinished implementation copy');
    assert.doesNotMatch(src, /localStorage\.setItem\([^)]*voice/i, 'voice smoke must not persist audio state in localStorage');
  });

  it('creates a recognition connection in Voice and selects its ASR model', async () => {
    const src = await readFile(
      join(REPO_ROOT, 'apps/desktop/src/renderer/settings/voice-settings-page.tsx'),
      'utf8',
    );
    const zhCopy = getVoiceSettingsCopy('zh');

    assert.match(src, /<AddProviderForm[\s\S]*providerType="openai-compatible"/);
    assert.match(
      src,
      /onClick=\{\(\) => setCreatingRecognitionConnection\(true\)\}/,
      'Voice must expose the create-recognition-connection action in place',
    );
    assert.match(
      src,
      /const created = connections\.find\(\(connection\) => connection\.slug === slug\);[\s\S]*recognition:\s*\{[\s\S]*connectionSlug: created\.slug,[\s\S]*model: created\.defaultModel/,
      'a newly created connection must become the selected recognition connection and model',
    );
    assert.match(
      src,
      /await props\.onRefreshConnections\(\);[\s\S]*setCreatingRecognitionConnection\(false\)/,
      'Voice must refresh the shared connection list before closing the create dialog',
    );
    assert.equal(zhCopy.createRecognitionConnection, '新建识别连接');
    assert.match(zhCopy.createRecognitionConnectionSubtitle, /ASR 模型 ID/);
  });

  it('edits the selected recognition connection in Voice without exposing its saved API key', async () => {
    const pageSource = await readFile(
      join(REPO_ROOT, 'apps/desktop/src/renderer/settings/voice-settings-page.tsx'),
      'utf8',
    );
    const formSource = await readFile(
      join(REPO_ROOT, 'apps/desktop/src/renderer/settings/voice-recognition-connection-form.tsx'),
      'utf8',
    );
    const zhCopy = getVoiceSettingsCopy('zh');

    assert.match(
      pageSource,
      /useOptimisticSettingsDraft<AppSettings\['voice'\]>\([\s\S]*return result\.settings\.voice;[\s\S]*const recognitionDraft = voiceDraft\.recognition;[\s\S]*const selectedRecognitionConnection = enabledConnections\.find\([\s\S]*recognitionDraft\.connectionSlug/,
      'the edit action must target the currently selected recognition connection',
    );
    assert.match(pageSource, /<VoiceRecognitionConnectionForm[\s\S]*onSaved=\{finishEditingRecognitionConnection\}/);
    assert.match(
      formSource,
      /bridge\.update\(props\.connection\.slug,\s*\{[\s\S]*baseUrl: normalizedBaseUrl,[\s\S]*defaultModel: normalizedModel,[\s\S]*apiKey: apiKey\.trim\(\)/,
      'the editor must save endpoint, ASR model, and an explicitly entered replacement key',
    );
    assert.match(
      formSource,
      /apiKey\.trim\(\) \? \{ apiKey: apiKey\.trim\(\) \} : \{\}/,
      'an empty API key field must preserve the stored secret',
    );
    assert.doesNotMatch(
      formSource,
      /resolveConnectionSecret|credentialStore|apiKey:\s*props\.connection/,
      'the renderer editor must never read the stored API key back',
    );
    assert.match(zhCopy.recognitionConnectionEndpointHelp, /不要包含 \/audio\/transcriptions/);
    assert.match(zhCopy.recognitionConnectionApiKeyHelp, /只有填写新值时才会替换/);
  });

  it('keeps realtime secrets in main and binds coordinator calls to their own task session', async () => {
    const hookSource = await readFile(
      join(REPO_ROOT, 'apps/desktop/src/renderer/use-voice-input.ts'),
      'utf8',
    );
    const shellSource = await readFile(
      join(REPO_ROOT, 'apps/desktop/src/renderer/app-shell.tsx'),
      'utf8',
    );
    const preloadSource = await readFile(
      join(REPO_ROOT, 'apps/desktop/src/preload/preload.ts'),
      'utf8',
    );

    assert.match(
      hookSource,
      /createRealtimeSession\(offer\.sdp \?\? ''\)/,
      'renderer must send only its SDP offer through the trusted bridge',
    );
    assert.match(hookSource, /sdp:\s*session\.answerSdp/);
    assert.doesNotMatch(hookSource, /session\.(?:clientSecret|endpoint)/);
    assert.doesNotMatch(hookSource, /fetch\(session\./);
    assert.match(
      preloadSource,
      /createRealtimeSession\(offerSdp: string\)[\s\S]*ipcRenderer\.invoke\('voice:createRealtimeSession', offerSdp\)/,
      'preload must not expose the endpoint or ephemeral credential',
    );
    assert.match(hookSource, /taskSessionId\?: string/);
    assert.match(
      hookSource,
      /inputRef\.current\.runCoordinatorTool\(call,\s*\{[\s\S]*taskSessionId: active\.taskSessionId/,
      'the live DataChannel handler must use current callbacks and its voice-session-owned task',
    );

    const coordinatorBlock = shellSource.slice(
      shellSource.indexOf('runCoordinatorTool: async'),
      shellSource.indexOf('onBlocked:', shellSource.indexOf('runCoordinatorTool: async')),
    );
    assert.match(coordinatorBlock, /onSessionResolved/);
    assert.match(coordinatorBlock, /const sessionId = context\.taskSessionId/);
    assert.match(
      coordinatorBlock,
      /const authoritativeSessions = await refreshSessions\(\)/,
      'coordinator status checks must refresh through the session workspace owner',
    );
    assert.match(coordinatorBlock, /window\.maka\.sessions\.readMessages\(sessionId\)/);
    assert.doesNotMatch(
      coordinatorBlock,
      /sessions\.find|const lastAssistant = \[\.\.\.messages\]/,
      'status and summaries must not read the render that opened the DataChannel',
    );
  });

  it('keeps success and permission states as deterministic stories', async () => {
    const stories = await readFile(
      join(REPO_ROOT, 'apps/desktop/stories/settings/settings-pages.stories.tsx'),
      'utf8',
    );

    assert.match(stories, /export const Voice: Story =/, 'voice must keep its idle page baseline');
    assert.match(stories, /export const VoiceSuccess: Story =/, 'voice must expose a successful local-capture baseline');
    assert.match(
      stories,
      /export const VoicePermissionDenied: Story =/,
      'voice must expose a permission-denied baseline',
    );
    assert.match(
      stories,
      /restoreProperty\(navigator, 'mediaDevices', mediaDevicesMock, mediaDevices\)/,
      'voice story browser mocks must restore the original mediaDevices property',
    );
    assert.match(
      stories,
      /restoreProperty\(globalThis, 'MediaRecorder', StoryMediaRecorder, mediaRecorder\)/,
      'voice story browser mocks must restore the original MediaRecorder property',
    );
    assert.match(
      stories,
      /if \(Reflect\.get\(target, property\) !== ownedValue\) return;/,
      'voice story browser mocks must not overwrite a newer owner during cleanup',
    );
  });

  it('keeps the microphone permission probe rejection-safe', async () => {
    const src = await readSettingsCombinedSource();
    const probe = src.match(/async function readBrowserMicrophonePermission[\s\S]*?function classifyVoicePermissionError/)?.[0];
    assert.ok(probe, 'voice microphone permission probe must be discoverable');
    assert.match(
      probe!,
      /try \{[\s\S]*const result = await query\.call\(navigator\.permissions, \{ name: 'microphone' \}\);[\s\S]*\} catch \{[\s\S]*return 'unknown';[\s\S]*\}/,
      'permission query rejection must degrade to unknown instead of surfacing an unhandled rejection',
    );
    assert.match(
      src,
      /async function readMicrophonePermission[\s\S]*window\.maka\.permissions\.getSnapshot\(\)[\s\S]*readBrowserMicrophonePermission\(\)/,
      'Voice must prefer the main-process OS permission snapshot and use the browser probe only as a fallback',
    );
    assert.match(
      src,
      /window\.addEventListener\('focus', refreshWhenVisible\)/,
      'Voice must re-read microphone permission after the user returns from System Settings',
    );
    assert.match(
      src,
      /let permissionReadRevision = 0;[\s\S]*const revision = \+\+permissionReadRevision;[\s\S]*revision === permissionReadRevision/,
      'an older microphone probe must not overwrite a newer focus-triggered permission read',
    );
  });

  it('routes microphone consent through the typed permission bridge before capture', async () => {
    const src = await readFile(
      join(REPO_ROOT, 'apps/desktop/src/renderer/settings/voice-settings-page.tsx'),
      'utf8',
    );
    const run = src.match(/async function runCaptureSmoke\(\)[\s\S]*?(?=\n  return \()/)?.[0] ?? '';
    assert.match(run, /window\.maka\.permissions\.getSnapshot\(\)/);
    assert.match(
      run,
      /systemMicrophone\.status !== 'granted'[\s\S]*systemMicrophone\.status !== 'not_determined'[\s\S]*openSystemSettings\('microphone'\)[\s\S]*systemMicrophone\.status === 'denied'/,
      'denied and unknown macOS microphone states must fail closed into System Settings instead of triggering renderer capture',
    );
    assert.match(
      run,
      /systemMicrophone\?\.status === 'not_determined'[\s\S]*requestAccess\('microphone'\)[\s\S]*if \(!voicePageMountedRef\.current\) return;[\s\S]*navigator\.mediaDevices\.getUserMedia/,
      'first-use consent must settle before the renderer starts capture',
    );
  });

  it('gates voice capture smoke with a synchronous pending owner', async () => {
    const src = await readSettingsCombinedSource();
    const voicePage = src.match(/function VoiceModelsSettingsPage\([\s\S]*?async function readBrowserMicrophonePermission/)?.[0];
    assert.ok(voicePage, 'voice settings page source must be discoverable');
    assert.match(
      voicePage!,
      /const captureSmokeGuard = useActionGuard<'smoke'>\(\)/,
      'voice capture smoke needs a synchronous guard so fast double-clicks cannot start duplicate microphone captures before React disables the button',
    );
    assert.match(
      voicePage!,
      /async function runCaptureSmoke\(\) \{\s*if \(captureSmokeGuard\.current !== null\) return;[\s\S]*captureSmokeGuard\.begin\('smoke'\);[\s\S]*navigator\.mediaDevices\.getUserMedia/,
      'voice capture smoke must take the synchronous lock before the first getUserMedia await',
    );
    assert.match(
      voicePage!,
      /finally \{[\s\S]*stream\?\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\);[\s\S]*captureSmokeGuard\.finish\(\);[\s\S]*setIsBusy\(false\);[\s\S]*\}/,
      'voice capture smoke must release the guard after stopping microphone tracks',
    );
    assert.match(voicePage!, /aria-busy=\{isBusy\}/, 'voice capture button must expose the pending state to assistive tech');
    assert.match(voicePage!, /data-pending=\{isBusy \? 'true' : undefined\}/, 'voice capture button must expose a stable pending hook');
  });

  it('connects the voice capture action to its live status copy', async () => {
    const src = await readSettingsCombinedSource();
    const voicePage = src.match(/function VoiceModelsSettingsPage\([\s\S]*?async function readBrowserMicrophonePermission/)?.[0];
    assert.ok(voicePage, 'voice settings page source must be discoverable');
    assert.match(
      // Pin the voice page file itself: the combined source used to satisfy
      // this import pattern via an unrelated page (#1042 split it away).
      await readFile(join(REPO_ROOT, 'apps/desktop/src/renderer/settings/voice-settings-page.tsx'), 'utf8'),
      /import \{ useEffect, useId, useRef, useState \} from 'react';/,
      'voice capture status needs a stable React id rather than a hard-coded duplicate id',
    );
    assert.match(
      voicePage!,
      /const smokeStatusId = useId\(\);/,
      'voice capture status should have a stable id for the action description relationship',
    );
    assert.match(
      voicePage!,
      /aria-describedby=\{smokeStatusId\}/,
      'voice capture button must reference the current status message',
    );
    assert.match(
      voicePage!,
      /<Alert[\s\S]*?id=\{smokeStatusId\}[\s\S]*?role="status"\s*>/,
      'voice capture status must expose both the referenced id and live status role',
    );
    assert.match(
      voicePage!,
      /variant=\{smoke\.status === 'error' \? 'error' : smoke\.status === 'ok' \? 'success' : 'passive'\}/,
      'voice capture failures and successes must use matching alert treatments while expected states stay neutral',
    );
  });

  it('drops late voice capture UI writes after Settings is closed', async () => {
    const src = await readSettingsCombinedSource();
    const voicePage = src.match(/function VoiceModelsSettingsPage\([\s\S]*?async function readBrowserMicrophonePermission/)?.[0];
    assert.ok(voicePage, 'voice settings page source must be discoverable');
    assert.match(
      voicePage!,
      /const captureSmokeGuard = useActionGuard<'smoke'>\(\);[\s\S]*const voicePageMountedRef = useMountedRef\(\);[\s\S]*const activeVoiceCaptureStreamRef = useRef<MediaStream \| null>\(null\);[\s\S]*return \(\) => \{[\s\S]*activeVoiceCaptureStreamRef\.current\?\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\);[\s\S]*activeVoiceCaptureStreamRef\.current = null;/,
      'voice capture smoke must track page ownership and stop the active stream when Settings closes (the shared guard hook releases the pending owner)',
    );
    assert.match(
      voicePage!,
      /stream = await navigator\.mediaDevices\.getUserMedia[\s\S]*activeVoiceCaptureStreamRef\.current = stream;[\s\S]*if \(!voicePageMountedRef\.current\) return;/,
      'voice capture smoke must remember the active MediaStream before the mounted check so unmount cleanup can stop it immediately',
    );
    assert.match(
      voicePage!,
      /await navigator\.mediaDevices\.getUserMedia[\s\S]*if \(!voicePageMountedRef\.current\) return;[\s\S]*setPermission\('granted'\);/,
      'voice capture smoke must not continue writing page state after microphone permission resolves for an unmounted page',
    );
    assert.match(
      voicePage!,
      /if \(voicePageMountedRef\.current\) \{[\s\S]*setSmoke\(\{ status: 'ok'[\s\S]*toast\.success\(copy\.success/,
      'voice capture success toast must only fire while the voice Settings page is still mounted',
    );
    assert.match(
      voicePage!,
      /if \(voicePageMountedRef\.current\) \{[\s\S]*setPermission\(next\);[\s\S]*toast\.error\(copy\.failedTitle/,
      'voice capture failure toast must only fire while the voice Settings page is still mounted',
    );
    assert.match(
      voicePage!,
      /finally \{[\s\S]*stream\?\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\);[\s\S]*if \(activeVoiceCaptureStreamRef\.current === stream\) \{[\s\S]*activeVoiceCaptureStreamRef\.current = null;[\s\S]*\}[\s\S]*captureSmokeGuard\.finish\(\);[\s\S]*if \(voicePageMountedRef\.current\) \{[\s\S]*setIsBusy\(false\);/,
      'voice capture cleanup must stop microphone tracks, clear the active stream owner, and only write React state while mounted',
    );
  });

  it('uses user-facing copy and a named list for voice privacy boundaries', async () => {
    const src = await readSettingsCombinedSource();
    const voicePage = src.match(/function VoiceModelsSettingsPage\([\s\S]*?async function readBrowserMicrophonePermission/)?.[0];
    const zhCopy = getVoiceSettingsCopy('zh');
    const visibleBoundaryCopy = [zhCopy.subtitle, zhCopy.boundaryAria, ...zhCopy.boundaries].join('\n');
    assert.ok(voicePage, 'voice settings page source must be discoverable');
    assert.match(voicePage!, /aria-label=\{copy\.boundaryAria\}/, 'voice boundary list must use its localized accessible name');
    assert.match(voicePage!, /copy\.boundaries\.map/, 'voice boundary list must render the active catalog');
    assert.match(visibleBoundaryCopy, /语音转写和语音朗读模型必须遵守这个边界/, 'voice intro should avoid English STT/TTS acronyms');
    assert.match(visibleBoundaryCopy, /转写结果必须先回到消息输入框/, 'voice intro should use user-facing input box copy');
    assert.match(visibleBoundaryCopy, /录音样本只在本机内存里用于计算时长和大小/, 'voice boundary copy should avoid implementation metrics');
    assert.match(visibleBoundaryCopy, /配置语音转写模型之前/, 'voice cloud boundary should use user-facing provider copy');
    assert.match(visibleBoundaryCopy, /转写文本只进入消息输入框草稿/, 'voice draft boundary should use user-facing composer copy');
    assert.doesNotMatch(
      visibleBoundaryCopy,
      /renderer 内存|duration \/ bytes|tracks|chunks|STT|TTS|composer 草稿/,
      'voice boundary copy must not leak implementation or English product terms',
    );
  });

  it('capability center reports voice as partial smoke, not a dead placeholder', async () => {
    const src = await readFile(CAPABILITY_SNAPSHOT, 'utf8');
    const voiceBlock = src.match(/id:\s*'voice'[\s\S]*?runtimeProbe:\s*\{[\s\S]*?\},\r?\n\s*\}\),/);
    assert.ok(voiceBlock, 'voice capability block must exist');
    assert.match(voiceBlock![0], /state:\s*'partial'/, 'voice feature must be partial, not not_available');
    assert.match(voiceBlock![0], /本地麦克风录音自检已可用/, 'voice feature reason must name the shipped smoke path');
    assert.match(voiceBlock![0], /在设置 → 语音运行本地录音自检/, 'voice capability guidance must use localized Settings navigation copy after the voice/open-gateway split');
    assert.doesNotMatch(voiceBlock![0], /Settings · 语音/, 'voice capability guidance must not leak English Settings prefix');
    assert.doesNotMatch(voiceBlock![0], /voice capture\/playback not implemented/, 'old placeholder reason must not return');
  });

  it('capability center reports local memory as partial instead of missing write contract only', async () => {
    const src = await readFile(CAPABILITY_SNAPSHOT, 'utf8');
    const memoryBlock = src.match(/id:\s*'memory_write'[\s\S]*?runtimeProbe:\s*\{[\s\S]*?\},\r?\n\s*\}\),/);
    assert.ok(memoryBlock, 'memory capability block must exist');
    assert.match(memoryBlock![0], /label:\s*'Memory'/, 'capability label should cover visible local memory, not only writes');
    assert.match(memoryBlock![0], /state:\s*'partial'/, 'memory feature must be partial, not not_available');
    assert.match(memoryBlock![0], /本地 MEMORY\.md 已可见/, 'memory reason must name the shipped transparent file');
    assert.doesNotMatch(memoryBlock![0], /memory write contract not implemented/, 'old placeholder reason must not return');
  });

  it('capability center reports activity recorder as partial local Daily Review aggregation', async () => {
    const src = await readFile(CAPABILITY_SNAPSHOT, 'utf8');
    const activityBlock = src.match(/id:\s*'activity_recorder'[\s\S]*?runtimeProbe:\s*\{[\s\S]*?\},\r?\n\s*\}\),/);
    assert.ok(activityBlock, 'activity recorder capability block must exist');
    assert.match(activityBlock![0], /state:\s*'partial'/, 'activity recorder must be partial, not not_available');
    assert.match(activityBlock![0], /Daily Review 已聚合本地会话/, 'activity reason must name the shipped local aggregation path');
    assert.match(activityBlock![0], /当前不包含屏幕与应用级录制/, 'activity reason must keep the unshipped recorder boundary visible without implementation-status copy');
    assert.match(activityBlock![0], /id:\s*'screen_recording',\s*required:\s*false/, 'unshipped screen recorder permission must not make Health show an app-wide error');
    assert.doesNotMatch(activityBlock![0], /activity timeline not implemented/, 'old placeholder reason must not return');
  });

  it('capability center uses user-facing unavailable copy instead of implementation placeholders', async () => {
    const [settings, snapshot] = await Promise.all([
      readSettingsCombinedSource(),
      readFile(CAPABILITY_SNAPSHOT, 'utf8'),
    ]);
    assert.equal(getPermissionCenterCopy('zh').layers.featureStates.not_available, '未开放', 'not_available label should be product-facing copy');
    assert.doesNotMatch(settings, /尚未实现/, 'Settings capability UI must not render not_available as unfinished implementation copy');
    assert.doesNotMatch(snapshot, /not implemented|missing_token|local gateway disabled|未接入|尚未接入|helper/, 'capability reasons must not leak internal placeholder/error identifiers');
    assert.match(snapshot, /未找到通过完整性检查的 cua-driver artifact/, 'Computer Use unavailable copy must name the failed artifact integrity boundary');
    assert.match(snapshot, /按目标与动作类别授权后可操作本机应用/, 'Computer Use enabled copy must keep scoped approval visible');
    assert.match(snapshot, /本地 Gateway 已关闭/, 'Open Gateway disabled state must use user-facing copy');
    assert.match(snapshot, /等待生成访问 token/, 'Open Gateway missing token state must use actionable waiting copy');
    assert.doesNotMatch(snapshot, /缺少访问 token/, 'Open Gateway missing token state should not read like a raw missing-field error');
  });

  it('capability center does not expose raw English implementation reasons', async () => {
    const snapshot = await readFile(CAPABILITY_SNAPSHOT, 'utf8');
    assert.match(snapshot, /未配置平台凭据/, 'bot missing credentials state must be localized');
    assert.match(snapshot, /macOS 不区分辅助功能权限是未授权还是未申请/, 'Accessibility TCC limitation must be localized');
    assert.match(
      snapshot,
      /Electron 无法可靠读取 macOS 通知授权状态，请在系统设置中确认/,
      'notification unknown state must be honest, localized, and actionable',
    );
    assert.match(snapshot, /Electron 暂不支持读取逐 App 的 Apple Events 授权状态/, 'Automation TCC limitation must be localized');
    assert.doesNotMatch(
      snapshot,
      /missing platform credentials|macOS does not expose|main process cannot read|no Electron API|macOS TCC only|Electron Notification unsupported/,
      'Settings capability reasons must not leak raw English implementation copy',
    );
  });
});
