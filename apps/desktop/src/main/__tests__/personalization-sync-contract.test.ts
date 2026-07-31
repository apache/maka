/**
 * Source-grounded contract for PR-PERSONALIZATION-SYNC-0
 * (WAWQAQ msg 23c079a9 round 7) + PR-TONE-AUTOSAVE-0.
 *
 * The personalization form initializes from
 * `props.settings.personalization` once on mount. Without a sync
 * effect, the visible inputs diverge from the persisted store after
 * server-side sanitization rewrites the saved value.
 *
 * PR-TONE-AUTOSAVE-0: the block used to carry the page's only explicit
 * save control + helper line while every neighbor persisted silently on
 * change/blur. It now autosaves like its siblings — 显示名称 flushes on
 * blur, 界面语言 persists on change, 助手语气偏好 debounces mid-typing and
 * flushes on blur — with no button and no success toast (silence is the
 * page's success language; only failures surface via toast.error).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';


describe('Personalization form state sync (PR-PERSONALIZATION-SYNC-0)', () => {
  async function readPersonalizationPage(): Promise<string> {
    const src = await readSettingsCombinedSource();
    const pageStart = src.indexOf('function PersonalizationSettingsPage');
    assert.notEqual(pageStart, -1, 'PersonalizationSettingsPage must exist');
    // Window widened for PR-TONE-AUTOSAVE-0: the autosave rewrite added the
    // shared persist path + per-field handlers, pushing the tone textarea's
    // blur flush (the last JSX row) past the old 7000-char slice.
    return src.slice(pageStart, pageStart + 8500);
  }

  it('PersonalizationSettingsPage syncs state when persisted personalization changes', async () => {
    // Anchor on the function declaration and slice forward by a
    // generous window — the body is ~250 lines but the sync
    // useEffect appears in the first ~30 after init.
    const head = await readPersonalizationPage();
    // useEffect block resetting all three input states from `value.*`.
    assert.match(
      head,
      /useEffect\(\(\) => \{[\s\S]*?setDisplayName\(value\.displayName\)[\s\S]*?setAssistantTone\(value\.assistantTone\)[\s\S]*?setUiLocale\(value\.uiLocale\)[\s\S]*?\},\s*\[\s*value\.displayName,\s*value\.assistantTone,\s*value\.uiLocale,?\s*\]\)/,
      'PersonalizationSettingsPage must sync local state when persisted values change',
    );
    // The sync must not clobber a value the user is mid-editing while an
    // autosave for it is still in flight — guarded on the pending count.
    assert.match(
      head,
      /if \(persistPendingCountRef\.current > 0\) return;[\s\S]*?setDisplayName\(value\.displayName\)/,
      'Personalization state sync must skip while an autosave is in flight',
    );
  });

  it('PersonalizationSettingsPage scrubs save failures before showing a toast', async () => {
    const page = await readPersonalizationPage();

    assert.match(
      page,
      /catch \(error\) \{[\s\S]*toast\.error\(copy\.saveFailed, settingsActionErrorMessage\(error, locale\)\)/,
      'Personalization save failures must use the shared Settings error scrubber',
    );
    assert.doesNotMatch(
      page,
      /const message = error instanceof Error \? error\.message : String\(error\)[\s\S]*toast\.error\('保存失败', message\)/,
      'Personalization save failures must not toast raw Error.message',
    );
  });

  it('PersonalizationSettingsPage autosaves via a field-aware persist path', async () => {
    const page = await readPersonalizationPage();

    // Shared persist helper takes a partial personalization patch and
    // routes through onUpdate.
    assert.match(
      page,
      /async function persistPersonalization\(patch: Partial<PersonalizationSettings>\) \{[\s\S]*?await props\.onUpdate\(\{ personalization: patch \}\)/,
      'Personalization must persist a partial patch through a shared autosave path',
    );
    // The shared ticket suppresses stale failure feedback, while locale
    // reconciliation has separate ownership because unrelated fields must
    // not supersede a pending language save.
    assert.match(
      page,
      /const persistTicketRef = useRef\(0\)/,
      'Personalization autosave must carry a monotonic ticket for last-write-wins',
    );
    assert.match(
      page,
      /const ticket = \+\+persistTicketRef\.current;[\s\S]*?const localeTicket = patch\.uiLocale === undefined \? null : \+\+localePersistTicketRef\.current/,
      'Personalization autosave must allocate locale ownership independently from the shared request ticket',
    );
    assert.match(
      page,
      /const persistPendingCountRef = useRef\(0\)/,
      'Personalization autosave must track pending saves so the sync effect can defer',
    );
  });

  it('PersonalizationSettingsPage debounces the tone textarea and flushes on blur', async () => {
    const page = await readPersonalizationPage();

    // A debounce timer + a fixed interval constant.
    assert.match(
      page,
      /const TONE_AUTOSAVE_DEBOUNCE_MS = \d+/,
      'Tone autosave must debounce on a fixed interval constant',
    );
    assert.match(
      page,
      /const toneDebounceRef = useRef<ReturnType<typeof setTimeout> \| null>\(null\)/,
      'Tone autosave must hold a debounce timer ref',
    );
    assert.match(
      page,
      /function scheduleToneSave\([\s\S]*?toneDebounceRef\.current = setTimeout\([\s\S]*?assistantTone:[\s\S]*?\},\s*TONE_AUTOSAVE_DEBOUNCE_MS\)/,
      'Tone autosave must schedule a debounced persist after the user stops typing',
    );
    // Blur wins immediately: clears the pending timer and persists now.
    assert.match(
      page,
      /function flushTone\([\s\S]*?clearTimeout\(toneDebounceRef\.current\)[\s\S]*?persistPersonalization\(\{ assistantTone:/,
      'Tone blur must clear the debounce timer and flush the save immediately',
    );
    assert.match(
      page,
      /onBlur=\{\(\) => flushTone\(assistantTone\)\}/,
      'Tone textarea must flush on blur',
    );
    // The tone textarea change handler must schedule the debounced save.
    assert.match(
      page,
      /onChange=\{\(value\) => \{[\s\S]*?const next = value\.slice\(0, 500\);[\s\S]*?setAssistantTone\(next\);[\s\S]*?scheduleToneSave\(next\);/,
      'Tone textarea onChange must schedule the debounced autosave',
    );
  });

  it('PersonalizationSettingsPage autosaves display name on blur and locale on change', async () => {
    const page = await readPersonalizationPage();

    assert.match(
      page,
      /onBlur=\{\(\) => flushDisplayName\(displayName\)\}[\s\S]*?label=\{copy\.displayName\}/,
      'Display name must flush its autosave on blur',
    );
    assert.match(
      page,
      /onChange=\{\(next\) => persistLocale\(next as UiLocalePreference\)\}[\s\S]*?ariaLabel=\{copy\.interfaceLanguage\}/,
      'Locale segmented control must persist immediately on change',
    );
  });

  it('PersonalizationSettingsPage has no explicit save control in the personalization block', async () => {
    const page = await readPersonalizationPage();

    // Autosave siblings never render an in-row commit control; the block
    // must not reintroduce one, nor its describing helper id/copy.
    assert.doesNotMatch(
      page,
      /<Button[\s\S]*?onClick=\{\(\) => void save\(\)\}/,
      'Personalization block must not carry an in-row commit control',
    );
    assert.doesNotMatch(
      page,
      /const personalizationSaveHelpId = useId\(\)/,
      'The dropped commit control must not leave its describing help id behind',
    );
    assert.doesNotMatch(
      page,
      /aria-describedby=\{personalizationSaveHelpId\}/,
      'No control should reference the removed persistence-boundary help copy',
    );
  });

  it('PersonalizationSettingsPage stays silent on success (no toast, autosave language)', async () => {
    const page = await readPersonalizationPage();

    // Silence is the page's success language — matching every autosave
    // sibling. No confirmation toast on a successful persist.
    assert.doesNotMatch(
      page,
      /toast\.success\(/,
      'Personalization autosave must not fire a success toast',
    );
    assert.doesNotMatch(
      page,
      /toast\.warning\(/,
      'Personalization autosave must not fire a warning toast',
    );
  });

  it('PersonalizationSettingsPage drops late save UI writes after Settings is closed', async () => {
    const page = await readPersonalizationPage();

    assert.match(
      page,
      /const personalizationMountedRef = useMountedRef\(\)/,
      'Personalization save must track page ownership separately from React pending state',
    );
    assert.match(
      page,
      /useEffect\(\(\) => \{[\s\S]*return \(\) => \{[\s\S]*persistTicketRef\.current \+= 1;/,
      'Personalization cleanup must release page ownership when Settings closes',
    );
    // Cleanup must invalidate any in-flight save's late apply (bump ticket)
    // and drop a pending debounced flush so it can't fire post-unmount.
    assert.match(
      page,
      /return \(\) => \{[\s\S]*persistTicketRef\.current \+= 1;[\s\S]*clearTimeout\(toneDebounceRef\.current\)/,
      'Personalization cleanup must invalidate in-flight saves and cancel the pending debounce',
    );
    // A stale canonical locale must not be reconciled into the form after
    // Settings closes: the mount + locale ownership guards gate the write.
    assert.match(
      page,
      /if \(!personalizationMountedRef\.current\) return;[\s\S]*localeTicket === localePersistTicketRef\.current[\s\S]*setUiLocale\(result\.settings\.personalization\.uiLocale\)/,
      'Personalization save must not reconcile a stale UI locale after Settings is closed',
    );
    assert.match(
      page,
      /catch \(error\) \{[\s\S]*if \(!personalizationMountedRef\.current\) return;[\s\S]*if \(ticket === persistTicketRef\.current\) \{[\s\S]*toast\.error\(copy\.saveFailed, settingsActionErrorMessage\(error, locale\)\)/,
      'Personalization failure toast must only fire while the page still owns the save',
    );
  });

  it('keeps locale rollback ownership independent from unrelated personalization saves', async () => {
    const page = await readPersonalizationPage();

    assert.match(
      page,
      /const localePersistTicketRef = useRef\(0\)/,
      'Locale saves need their own request ownership instead of sharing the latest personalization ticket',
    );
    assert.match(
      page,
      /const localeTicket = patch\.uiLocale === undefined \? null : \+\+localePersistTicketRef\.current/,
      'Unrelated display-name or tone saves must not supersede a pending locale save',
    );
    assert.match(
      page,
      /catch \(error\) \{[\s\S]*localeTicket !== null[\s\S]*localeTicket === localePersistTicketRef\.current[\s\S]*setUiLocale\(value\.uiLocale\)/,
      'The latest locale failure must restore the persisted preference even when another field saved later',
    );
    assert.doesNotMatch(
      page,
      /ticket === persistTicketRef\.current[^}]*patch\.uiLocale !== undefined[^}]*setUiLocale\(value\.uiLocale\)/,
      'Locale rollback must not be gated by the shared personalization latest-request ticket',
    );
  });
});
