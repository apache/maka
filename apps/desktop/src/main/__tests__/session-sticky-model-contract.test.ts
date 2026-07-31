import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readProviderSettingsCombinedSource } from './provider-contract-source-helpers.js';
import { describe, it } from 'node:test';
import { readRendererContractCss } from './contract-css-helpers.js';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

// The model switcher / picker JSX lives in `chat-model-switcher.tsx`, its
// shared searchable popup in `model-picker.tsx`, the composer renders it from
// `composer.tsx`, and turn chips render in `chat-view.tsx`. These source-grep
// contracts assert behavior that spans the seam, so search their union.
async function readModelSwitcherUiSource(): Promise<string> {
  const [composer, chatView, switcher, picker] = await Promise.all([
    readFile(resolve(REPO_ROOT, 'packages/ui/src/composer.tsx'), 'utf8'),
    readFile(resolve(REPO_ROOT, 'packages/ui/src/chat-view.tsx'), 'utf8'),
    readFile(resolve(REPO_ROOT, 'packages/ui/src/chat-model-switcher.tsx'), 'utf8'),
    readFile(resolve(REPO_ROOT, 'packages/ui/src/model-picker.tsx'), 'utf8'),
  ]);
  return `${composer}\n${chatView}\n${switcher}\n${picker}`;
}

describe('PR-SESSION-STICKY-MODEL-0 contract', () => {
  it('captures the ready model when creating a desktop session', async () => {
    const main = await readMainProcessCombinedSource();

    assert.match(main, /const requestedSlug = input\?\.llmConnectionSlug \?\? \(await connectionStore\.getDefault\(\)\)/);
    assert.match(main, /const \{ connection, model \} = await getReadyConnection\(requestedSlug, input\?\.model\)/);
    assert.match(main, /createSession\(\{[\s\S]*llmConnectionSlug: connection\.slug,[\s\S]*model,/);
  });

  it('validates sends against the session model, not the latest provider default', async () => {
    const readiness = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/main/chat-readiness.ts'), 'utf8');
    const coreReadiness = await readFile(resolve(REPO_ROOT, 'packages/core/src/connection-readiness.ts'), 'utf8');
    const projection = await readFile(resolve(REPO_ROOT, 'packages/core/src/session-send-projection.ts'), 'utf8');
    const main = await readMainProcessCombinedSource();

    assert.match(readiness, /assertSessionCanSend\([\s\S]*header: Pick<SessionHeader, 'backend' \| 'llmConnectionSlug' \| 'model'>/);
    assert.match(readiness, /requireReadyConnection\(header\.llmConnectionSlug, deps, header\.model\)/);
    // Codex normalization moved to @maka/core (#1038) so the send gate
    // and the session send projection share one normalization.
    assert.match(coreReadiness, /normalizeRequestedModelForReadiness\(\s*connection: LlmConnection,\s*requestedModel: string \| undefined,\s*\)/);
    assert.match(coreReadiness, /CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS\.has\(requestedModel\)/);
    assert.match(
      main,
      /deps\.getReadyConnection\(\s*input\.header\.llmConnectionSlug,\s*input\.header\.model,\s*\)/,
    );
    assert.match(main, /resolveDesktopBackendToolSurface\(deps, ctx\)/);
    assert.match(main, /header: \{ \.\.\.ctx\.header, model, permissionMode: effectivePermissionMode \}/);
    assert.match(main, /modelId: model/);
    // #1038: the locked/sticky guarantee lives in the core projection —
    // the desktop send gate delegates the decision to it.
    assert.match(projection, /Once a session has user messages, its connection\/model is sticky/);
    assert.match(projection, /if \(session\.connectionLocked\) \{\s*return \{ kind: 'blocked', reason: ownReason, connectionLocked: true \};\s*\}/);
    assert.match(readiness, /projectSessionSendOutcome\(\{\s*session: header,/);
  });

  it('preserves sticky model through branch sessions and session summaries', async () => {
    const runtime = await readFile(resolve(REPO_ROOT, 'packages/runtime/src/session-manager.ts'), 'utf8');
    const storage = await readFile(resolve(REPO_ROOT, 'packages/storage/src/session-store.ts'), 'utf8');
    const core = await readFile(resolve(REPO_ROOT, 'packages/core/src/session.ts'), 'utf8');

    assert.match(runtime, /branchFromTurn[\s\S]*model: header\.model/);
    assert.match(runtime, /model: h\.model/);
    assert.match(storage, /model: header\.model/);
    assert.match(core, /Sticky session default model id, captured when the session is created/);
  });

  it('surfaces the session model in the chat header and explains default-model scope', async () => {
    const renderer = await readRendererShellCombinedSource();
    const ui = await readModelSwitcherUiSource();
    const providers = await readProviderSettingsCombinedSource();

    assert.match(renderer, /normalizeActiveChatModel\(activeSession, activeConnection, chatModelChoices\)/);
    assert.match(ui, /copy\.pinnedSession\(props\.activeConnectionLabel, props\.activeModelLabel\)/);
    assert.match(ui, /copy\.switchTitle\(currentSessionModelTitle\)/);
    assert.match(providers, /copy\.enabledModelsHelp/);
  });

  it('lets the user explicitly switch the current session model from the chat header', async () => {
    const main = await readMainProcessCombinedSource();
    const preload = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/preload/preload.ts'), 'utf8');
    const globalTypes = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/preload/bridge-contract.d.ts'), 'utf8');
    const renderer = await readRendererShellCombinedSource();
    const ui = await readModelSwitcherUiSource();
    const chatModelSwitcher = await readFile(resolve(REPO_ROOT, 'packages/ui/src/chat-model-switcher.tsx'), 'utf8');
    const modelPicker = await readFile(resolve(REPO_ROOT, 'packages/ui/src/model-picker.tsx'), 'utf8');
    const styles = await readRendererContractCss();

    assert.match(main, /ipcMain\.handle\('sessions:setModel'[\s\S]*normalizeSessionModelSelection\(input\)/);
    assert.match(main, /getReadyConnection\(llmConnectionSlug, model\)/, 'model switch must reuse the send-path readiness gate');
    assert.match(main, /runtime\.updateSession\(sessionId, \{[\s\S]*llmConnectionSlug: ready\.connection\.slug,[\s\S]*model: ready\.model,[\s\S]*connectionLocked: true/);
    assert.match(main, /当前对话正在运行，等结束后再切换模型/);
    assert.match(main, /当前有工具调用正在等待确认，处理后再切换模型/);
    assert.match(preload, /setModel\(sessionId: string, input: \{ llmConnectionSlug: string; model: string \}\): Promise<SessionSummary>/);
    assert.match(globalTypes, /setModel\(sessionId: string, input: \{ llmConnectionSlug: string; model: string \}\): Promise<SessionSummary>/);
    assert.match(renderer, /modelChoices=\{chatModelChoices\}/);
    assert.match(renderer, /const sessionModelChangeRegistry = useKeyedPendingRegistry\(\);/);
    assert.match(
      renderer,
      /pendingSessionModelChangesRef: sessionModelChangeRegistry\.keysRef/,
      'the model-change dedup Set the setModel action guards on must be backed by the shared keyed-pending registry',
    );
    assert.match(renderer, /const sessionUi = useAppShellSessionUiState\(\);[\s\S]*setPendingSessionModelBySession: sessionUi\.setPendingSessionModelBySession/);
    assert.match(renderer, /const \{[\s\S]*pendingSessionModelBySession,[\s\S]*\} = sessionUiState;/);
    assert.match(renderer, /const sessionId = activeIdRef\.current;[\s\S]*pendingSessionModelChangesRef\.current\.has\(sessionId\)[\s\S]*window\.maka\.sessions\.setModel\(sessionId, input\)[\s\S]*finally \{[\s\S]*pendingSessionModelChangesRef\.current\.delete\(sessionId\);/);
    assert.match(
      renderer,
      /pendingSessionModelChangesRef\.current\.add\(sessionId\);[\s\S]*setPendingSessionModelBySession\(\(current\) => \(\{\s*\.\.\.current,\s*\[sessionId\]: true,?\s*\}\)\);/,
      'app shell must expose per-session model pending state so switching away and back does not make a guarded request look idle',
    );
    assert.match(renderer, /delete next\[sessionId\];/);
    assert.match(
      renderer,
      /const next = await window\.maka\.sessions\.setModel\(sessionId, input\);[\s\S]*setSessions\([\s\S]*if \(activeIdRef\.current === sessionId\) \{[\s\S]*toastApi\.success\(copy\.modelSwitchedTitle/,
      'model switch success toast must only describe the current session when the original session is still active',
    );
    assert.match(
      renderer,
      /catch \(error\) \{[\s\S]*if \(activeIdRef\.current === sessionId\) \{[\s\S]*toastApi\.error\(copy\.modelFailedTitle, localizedShellErrorMessage\(error, copy\.modelFallback, uiLocale\)\);[\s\S]*\}[\s\S]*\} finally/,
      'model switch failure toast must not surface stale failures after the user switches sessions',
    );
    assert.doesNotMatch(
      renderer,
      /toastApi\.error\('切换模型失败', cleanErrorMessage\(error\)\)/,
      'model switch failures must not echo raw cleaned Error.message in visible toast feedback',
    );
    assert.match(renderer, /onModelChange=\{\(input\) => setSessionModel\(input\)\}/);
    assert.doesNotMatch(renderer, /onModelChange=\{\(input\) => void setSessionModel\(input\)\}/);
    assert.match(renderer, /modelChangePending=\{activeId \? pendingSessionModelBySession\[activeId\] === true : false\}/);
    assert.match(renderer, /buildCatalogChatModelChoices\(connections\)/);
    const catalogChoices = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/model-catalog-choices.ts'), 'utf8');
    assert.match(catalogChoices, /PROVIDER_DEFAULTS\[connection\.providerType\]/);
    assert.match(
      catalogChoices,
      /buildConnectionModelCatalogEntries\(\{ connection, savedModelIds \}\)/,
      'chat model choices must derive candidates from the shared model catalog',
    );
    assert.match(catalogChoices, /CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS\.has\(entry\.id\.trim\(\)\)/);
    assert.match(ui, /function ChatModelSwitcher/);
    assert.match(ui, /modelChangePending\?: boolean/);
    assert.match(ui, /pending=\{props\.modelChangePending\}/);
    assert.match(ui, /activeModel\?: string/);
    assert.match(ui, /const currentModel = props\.activeModel \?\? props\.activeSession\.model/);
    assert.match(ui, /ariaLabel=\{copy\.switchAriaLabel\}/);
    assert.match(ui, /pending\?: boolean/);
    assert.match(ui, /const pending = Boolean\(props\.pending\);/);
    assert.match(
      ui,
      /onValueChange=\{async \(value\) => \{[\s\S]*await props\.onChange\?\.\(next\);[\s\S]*\}\}/,
      'the model selection action must stay pending until the app-shell persistence owner settles',
    );
    assert.match(ui, /aria-busy=\{pending \? 'true' : undefined\}/);
    assert.match(ui, /data-pending=\{pending \? 'true' : undefined\}/);
    assert.match(ui, /<ModelPicker[\s\S]*groups=\{grouped\}[\s\S]*value=\{currentValue\}[\s\S]*loading=\{pending\}/);
    assert.match(ui, /<Selector[\s\S]*options=\{options\}[\s\S]*hasSearch/);
    assert.match(ui, /buildModelPickerOptions\(props\.groups, props\.leadingOption\)/);
    assert.doesNotMatch(ui, /useCombobox|usePopover|filterModelPickerOption|modelPickerHasCatalogMatches/);
    assert.doesNotMatch(modelPicker, /role="(?:listbox|option)"|aria-activedescendant|scrollIntoView/);
    assert.doesNotMatch(ui, /@base-ui\/react\/combobox|BaseCombobox/);
    assert.match(ui, /<SelectorOption[\s\S]*icon=\{providerMark\}/);
    assert.match(ui, /const providerType = providerTypes\.get\(option\.value\)/);
    assert.match(ui, /className="modelPickerProviderMark"[\s\S]*data-provider=\{providerType\}/);
    assert.match(ui, /leadingOption=\{!currentKnownChoice/);
    assert.doesNotMatch(`${chatModelSwitcher}\n${modelPicker}`, /\bfooter=|pinnedItem|DropdownMenu/);
    assert.doesNotMatch(ui, /<select\b[\s\S]*aria-label="切换当前会话模型"/);
    assert.match(ui, /className="maka-model-selection-controls"[\s\S]*<ThinkingLevelSelector/);
    assert.match(styles, /\.maka-model-switcher\s*\{/);
    assert.match(styles, /\.maka-model-switcher\[data-pending="true"\]\s*\{[\s\S]*cursor: progress;[\s\S]*\}/);
    assert.match(styles, /\.maka-model-selection-controls\s*\{[\s\S]*display:\s*inline-flex;[\s\S]*gap:/);
    assert.match(styles, /\.modelPickerOptionLabel\s*\{[\s\S]*text-overflow:\s*ellipsis;/);
    assert.doesNotMatch(styles, /\.modelPicker(?:Popup|List|SearchInput|Empty)|\.maka-thinking-(?:section|flyout)/);
  });
});
