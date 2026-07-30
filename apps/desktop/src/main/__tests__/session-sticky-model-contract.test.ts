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
    const uiPrimitives = await readFile(resolve(REPO_ROOT, 'packages/ui/src/ui.tsx'), 'utf8');
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
    assert.match(ui, /const \[localPending,\s*setLocalPending\] = useState\(false\);/);
    assert.match(ui, /const pendingRef = useRef\(false\);/);
    assert.match(ui, /const pending = props\.pending \|\| localPending;/);
    assert.match(ui, /const modelSwitcherMountedRef = useMountedRef\(\);/);
    assert.match(ui, /const pendingModelChangeRef = useRef<\{ sessionId: string; token: number \} \| null>\(null\);/);
    assert.match(ui, /const pendingModelChangeTokenRef = useRef\(0\);/);
    assert.match(
      ui,
      /useEffect\(\(\) => \{[\s\S]*return \(\) => \{[\s\S]*pendingModelChangeRef\.current = null;[\s\S]*pendingModelChangeTokenRef\.current \+= 1;[\s\S]*pendingRef\.current = false;[\s\S]*\};[\s\S]*\}, \[\]\);/,
      'model switcher must release pending ownership when the chat header unmounts',
    );
    assert.match(
      ui,
      /useEffect\(\(\) => \{[\s\S]*pendingModelChangeRef\.current\?\.sessionId === props\.activeSession\.id[\s\S]*pendingModelChangeRef\.current = null;[\s\S]*pendingModelChangeTokenRef\.current \+= 1;[\s\S]*pendingRef\.current = false;[\s\S]*setLocalPending\(false\);[\s\S]*\}, \[props\.activeSession\.id\]\);/,
      'model switcher must release row-local pending state when the active session changes',
    );
    assert.match(ui, /if \(pendingRef\.current \|\| props\.pending\) return;/);
    assert.match(ui, /const sessionId = props\.activeSession\.id;[\s\S]*const token = pendingModelChangeTokenRef\.current \+ 1;[\s\S]*pendingModelChangeRef\.current = \{ sessionId, token \};/);
    assert.match(
      ui,
      /void \(async \(\) => \{[\s\S]*try \{[\s\S]*await props\.onChange\?\.\(next\);[\s\S]*\} catch \{[\s\S]*\} finally \{[\s\S]*const owner = pendingModelChangeRef\.current;[\s\S]*modelSwitcherMountedRef\.current && owner\?\.sessionId === sessionId && owner\.token === token[\s\S]*pendingModelChangeRef\.current = null;[\s\S]*pendingRef\.current = false;[\s\S]*setLocalPending\(false\);/,
      'model switcher must only clear pending state for the matching session/token owner',
    );
    assert.match(ui, /aria-busy=\{pending \? 'true' : undefined\}/);
    assert.match(ui, /data-pending=\{pending \? 'true' : undefined\}/);
    assert.match(ui, /<ModelPicker[\s\S]*groups=\{grouped\}[\s\S]*value=\{currentValue\}[\s\S]*onValueChange=\{\(value\) => \{/);
    assert.match(ui, /<BaseCombobox\.Positioner sideOffset=\{8\}/);
    assert.match(ui, /<BaseCombobox\.List className="modelPickerList">/);
    assert.match(ui, /inputValue=\{query\}/);
    assert.match(ui, /filter=\{filterModelPickerOption\}/);
    assert.match(ui, /BaseCombobox\.useFilteredItems<ModelPickerOptionGroup>\(\)/);
    assert.match(ui, /footer=\{\(\{ open, close \}\) => \(/);
    assert.match(ui, /props\.footer\?\.\(\{[\s\S]*open,[\s\S]*close: \(\) => \{[\s\S]*setOpen\(false\);[\s\S]*setQuery\(''\);/);
    assert.match(ui, /data-model-picker-nested-popup=""/);
    // The grouped menu renders provider groups from Base UI's filtered item
    // source, each heading carrying the injected brand mark (kept out of
    // @maka/ui via renderProviderMark), on the shared `.settingsSelectMenu*`
    // recipe.
    assert.match(ui, /<ModelPickerGroup key=\{group\.key\} items=\{group\.items\}>/);
    assert.match(ui, /renderProviderMark\?\.\(group\.providerType\)/);
    assert.match(ui, /className="settingsSelectMenuGroupLogo"/);
    assert.match(ui, /<span className="flex h-4 w-4 items-center justify-center" aria-hidden="true">[\s\S]*<BaseCombobox\.ItemIndicator>/);
    assert.match(ui, /<BaseCombobox\.Item[\s\S]*<span className="min-w-0">\{children\}<\/span>/);
    assert.doesNotMatch(uiPrimitives, /BaseCombobox/, 'Combobox stays private to ModelPicker until a second real consumer appears');
    assert.doesNotMatch(ui, /<select\b[\s\S]*aria-label="切换当前会话模型"/);
    assert.match(ui, /<span className="maka-model-switcher-label">\{pending \? copy\.switching : copy\.model\}<\/span>/);
    assert.match(styles, /\.maka-model-switcher\s*\{/);
    assert.match(styles, /\.maka-model-switcher\[data-pending="true"\]\s*\{[\s\S]*cursor: progress;[\s\S]*\}/);
    assert.match(styles, /\.maka-model-switcher-trigger\s*\{/);
    // Popup/positioner/rows now come from the shared settings-select menu recipe
    // (the bespoke `.maka-model-switcher-popup` chrome was folded into it); the
    // trigger above stays the composer pill.
    assert.match(styles, /\.settingsSelectMenuPopup\s*\{/);
    assert.match(styles, /\.modelPickerPopup\s*\{[\s\S]*display:\s*flex;[\s\S]*overflow:\s*hidden;[\s\S]*\}/);
    assert.match(styles, /\.modelPickerList\s*\{[\s\S]*overflow-y:\s*auto;[\s\S]*\}/);
    assert.match(styles, /\.maka-thinking-section\s*\{[\s\S]*flex:\s*0 0 auto;[\s\S]*\}/);
    // [^}]* anchors inside this one rule block so the match can't drift when
    // cross-file @import order changes (#546 PR1 relocated this rule into
    // settings/select.css). Value is the control-lg token (= 32px), not a
    // literal - readRendererContractCss does not inline var().
    assert.match(styles, /\.settingsSelectMenuPopup \[role="option"\]\s*\{[^}]*min-height:\s*var\(--h-control-lg\)[^}]*\}/);
  });
});
