import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join, resolve } from 'node:path';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const PRELOAD_SOURCE = join(REPO_ROOT, 'apps', 'desktop', 'src', 'preload', 'preload.ts');
const GLOBAL_DTS = join(REPO_ROOT, 'apps', 'desktop', 'src', 'preload', 'bridge-contract.d.ts');

/**
 * PR-GENERAL-DEFAULTS-CONFIGURABLE-0 (WAWQAQ msg `d3ea9a33` 2026-06-26).
 *
 * The General page used to ship three read-only `<SettingRow>` lines —
 * "启动" / "新对话模式" / "默认模型" — that read like settings but had
 * no configurable backing. The fix dropped the two without persisted
 * storage and replaced the third with a real Astryx `<Selector>` wired
 * to `connections.setDefault`. This contract pins both halves so the
 * regression can't drift back in.
 */
describe('General settings configurable contract', () => {
  it('does not ship the three retired read-only SettingRow lines on General', async () => {
    const src = await readSettingsCombinedSource();
    // Each retired line was: `<SettingRow title="启动" detail="…" value="已启用" />`
    // etc. Test the trio of (title, hardcoded value) pairs.
    assert.doesNotMatch(
      src,
      /<SettingRow\s+title="启动"[\s\S]*?value="已启用"/,
      'General page must not re-introduce the read-only 启动 row — make it real (with a backing AppSettings field + IPC) or leave it out.',
    );
    assert.doesNotMatch(
      src,
      /<SettingRow\s+title="新对话模式"[\s\S]*?value="询问权限"/,
      'General page must not re-introduce the read-only 新对话模式 row — permission mode is per-session in the composer.',
    );
    // The 默认模型 row was: `<SettingRow ... value={props.defaultSlug ?? '未设置'} />`.
    // Block the SettingRow shape specifically; the new real control is the
    // shared searchable `<ModelPicker>` inside `<GeneralDefaultsCard>`.
    assert.doesNotMatch(
      src,
      /<SettingRow\s+title="默认模型"[\s\S]*?value=\{props\.defaultSlug/,
      'General page 默认模型 row must use the real <ModelPicker> inside <GeneralDefaultsCard>, not a read-only <SettingRow>.',
    );
  });

  it('renders a real <GeneralDefaultsCard> that persists the default model via model-level IPC', async () => {
    const src = await readSettingsCombinedSource();
    // The card must be defined and used.
    assert.match(
      src,
      /function GeneralDefaultsCard\(props: \{[\s\S]*connections:\s*readonly LlmConnection\[\];/,
      '<GeneralDefaultsCard> must accept a readonly LlmConnection[] so the General page can render every enabled connection',
    );
    assert.match(
      src,
      /<GeneralDefaultsCard\s+connections=\{props\.connections\}\s+defaultSlug=\{props\.defaultSlug\}\s+onRefresh=\{props\.onRefreshConnections\}[\s\S]*permissionMode=\{props\.settings\.chatDefaults\.permissionMode\}[\s\S]*onUpdate=\{props\.onUpdate\}/,
      '<GeneralDefaultsCard> must be mounted by the General-page render branch with connections / defaultSlug / onRefresh wired through',
    );
    // The actual picker + persistence must use the shared searchable
    // ModelPicker (also behind the composer's model switcher, so the two
    // surfaces can't drift) and the model-level default IPC. The old
    // connection-only selector used `connection.name`, which can embed OAuth
    // account email; default-model choices are grouped from safe model
    // catalog choices, with '未设置' as an ordinary searchable leading option.
    assert.match(
      src,
      /<ModelPicker[\s\S]*leadingOption=\{\{ value: '', label: copy\.notSet \}\}[\s\S]*ariaLabel=\{copy\.defaultModel\}[\s\S]*onValueChange=\{persistDefault\}/,
      'GeneralDefaultsCard must use the shared <ModelPicker> (same popup as the composer model switcher) so the two surfaces cannot drift',
    );
    assert.match(
      src,
      /buildCatalogChatModelChoices\(props\.connections\)[\s\S]*modelMenuGroups\(modelChoices, locale\)[\s\S]*modelChoiceValue\(choice\.connectionSlug, choice\.model\)/,
      'GeneralDefaultsCard must derive grouped connection/model choices from the safe model catalog',
    );
    assert.doesNotMatch(
      src,
      /opts\.push\(\[connection\.slug, connection\.name\]\)/,
      'GeneralDefaultsCard must not use connection.name as option copy because OAuth connection names can carry account emails',
    );
    assert.match(
      src,
      /window\.maka\.connections\.setDefaultModel\(/,
      'GeneralDefaultsCard must persist the selected connection+model pair through a model-level default IPC',
    );
  });

  it('guards GeneralDefaultsCard with the same mounted-ref + shared action-guard ownership pattern used elsewhere in SettingsModal', async () => {
    const src = await readSettingsCombinedSource();
    // Capture the function's body up to the next top-level `function`
    // declaration so per-card guards are checked inside the component.
    const cardBlock =
      src.match(/function GeneralDefaultsCard\(props:[\s\S]*?\n(?=function\s)/)?.[0] ?? '';
    assert.ok(cardBlock.length > 0, 'GeneralDefaultsCard source must be discoverable');
    assert.match(
      cardBlock,
      /const mountedRef = useMountedRef\(\);/,
      'GeneralDefaultsCard must track page-mounted ownership so a slow IPC write does not call setSaving(false) after Settings closes',
    );
    assert.match(
      cardBlock,
      /const persistGuard = useKeyedActionGuard<'default-model' \| 'permission-mode'>\(\)/,
      'GeneralDefaultsCard must use a synchronous guard from the shared hook so rapid duplicate selects do not race a previous in-flight save',
    );
    assert.match(
      cardBlock,
      /const releaseSave = persistGuard\.begin\('default-model'\);[\s\S]*if \(!releaseSave\) return;[\s\S]*setSaving\(true\);[\s\S]*await window\.maka\.connections\.setDefaultModel/,
      'GeneralDefaultsCard must take the synchronous guard lock before awaiting the IPC; React state alone is not enough to block double-clicks',
    );
    assert.match(
      cardBlock,
      /catch \(error\)[\s\S]*if \(mountedRef\.current\) \{[\s\S]*toast\.error\(copy\.saveDefaultModelFailed, settingsActionErrorMessage\(error, locale\)\)/,
      'GeneralDefaultsCard failures must surface a localized toast and only while still mounted — silent unhandled rejection regressed the page before',
    );
    assert.match(src, /saveDefaultModelFailed: '保存默认模型失败'/);
    assert.match(src, /saveDefaultModelFailed: 'Could not save the default model'/);
  });

  it('exposes a default-model IPC that validates the model against chat-selectable catalog entries', async () => {
    const main = await readMainProcessCombinedSource();
    const preload = await readFile(PRELOAD_SOURCE, 'utf8');
    const globalDts = await readFile(GLOBAL_DTS, 'utf8');

    assert.match(preload, /setDefaultModel\(input: \{ slug: string; model: string \} \| null\): Promise<void> \{[\s\S]*ipcRenderer\.invoke\('connections:setDefaultModel', input\)/);
    assert.match(globalDts, /setDefaultModel\(input: \{ slug: string; model: string \} \| null\): Promise<void>;/);
    assert.match(
      main,
      /ipcMain\.handle\('connections:setDefaultModel'[\s\S]*normalizeConnectionSlugForIpc\(input\.slug, 'connection slug'\)[\s\S]*buildConnectionModelCatalogEntries\(\{ connection \}\)[\s\S]*entry\.id === model && entry\.canUseAsChatDefault[\s\S]*connectionStore\.update\(slug, \{ defaultModel: model \}\)[\s\S]*connectionStore\.setDefault\(slug\)/,
      'main process must validate slug/model, reject non-chat defaults, update the connection default model, then set the default connection in one IPC',
    );
  });
});
