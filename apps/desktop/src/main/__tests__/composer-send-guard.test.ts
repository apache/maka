import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('composer send guard', () => {
  it('routes send through IconButton and passes the composite disabled state', async () => {
    const source = await readFile(
      join(process.cwd(), '../../packages/ui/src/composer.tsx'),
      'utf8',
    );
    const sendControl =
      source.match(
        /<IconButton\s+variant="primary"[\s\S]*?icon=\{<ArrowUp[\s\S]*?\/>/,
      )?.[0] ?? '';

    assert.match(
      sendControl,
      /isDisabled=\{sendDisabled\}/,
      'the send IconButton must receive the complete disabled decision',
    );
    assert.match(
      sendControl,
      /tooltip=\{sendTitle\}/,
      'the disabled send control must keep its actionable explanation',
    );
    assert.doesNotMatch(sendControl, /isIconOnly/, 'IconButton owns icon-only semantics');
  });

  it('keeps follow-up submits single-flight until the current send settles', async () => {
    const source = await readFile(join(process.cwd(), '../../packages/ui/src/composer.tsx'), 'utf8');
    const copySource = await readFile(join(process.cwd(), '../../packages/ui/src/conversation-copy.ts'), 'utf8');
    // Issue #1044: draft persistence moved into useComposerDraft; the draft
    // assertions read the hook, the send/toolbar assertions stay on Composer.
    const draftHook = await readFile(join(process.cwd(), '../../packages/ui/src/use-composer-draft.ts'), 'utf8');
    const sendCurrent = source.match(/async function sendCurrent\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(sendCurrent, /sendPendingRef\.current/, 'composer must use a ref guard for same-tick duplicate submits');
    assert.match(sendCurrent, /if \(props\.disabled \|\| sendPendingRef\.current \|\| importActionOwnerRef\.current\?\.pending\) return;/);
    assert.match(sendCurrent, /sendPendingRef\.current = true;[\s\S]*setSendPending\(true\);/);
    assert.match(sendCurrent, /finally \{[\s\S]*sendPendingRef\.current = false;[\s\S]*if \(composerMountedRef\.current\) setSendPending\(false\);[\s\S]*\}/);
    assert.match(source, /sendPending \? \(\s*copy\.sending\s*\)/, 'toolbar must surface the transient sending state');
    assert.match(draftHook, /const \[hasDraftText, setHasDraftText\] = useState\(false\);/);
    assert.match(
      draftHook,
      /rememberComposerDraft\(draftStoreRef\.current, activeDraftKeyRef\.current, nextValue\);[\s\S]*setHasDraftText\(Boolean\(nextValue\.trim\(\)\)\);/,
      'draft text state must follow the actual textarea draft value',
    );
    // U3: `noModelConnection` is folded into the guard so Send stays inert in
    // the post-skip no-model dead end (the inline hint points at Settings · 模型).
    assert.match(source, /\(!hasDraftText && skillDraft\.skills\.length === 0\)/);
    // #1565 PR 3: Astryx Button spells the disabled prop `isDisabled`.
    assert.match(source, /isDisabled=\{sendDisabled\}/, 'send button must be disabled while empty, in flight, or with no model connection');
    assert.match(copySource, /sendLabel: '发送'/, 'Chinese UI must not keep English Send button copy');
    assert.match(copySource, /stopLabel: '停止'/, 'Chinese UI must not keep English Stop button copy');
  });

  it('clears the submitted draft key when first send switches into a new session', async () => {
    const source = await readFile(join(process.cwd(), '../../packages/ui/src/composer.tsx'), 'utf8');
    const draftHook = await readFile(join(process.cwd(), '../../packages/ui/src/use-composer-draft.ts'), 'utf8');
    const sendCurrent = source.match(/async function sendCurrent\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(
      sendCurrent,
      /const submittedDraftKey = activeDraftKey\(\);[\s\S]*sent = await props\.onSend\(text, skillIds\);[\s\S]*if \(sent === false\) return;[\s\S]*clearDraft\(submittedDraftKey\);[\s\S]*saveCurrentDraft\(''\);/,
      'successful sends must clear both the original draft key and the current key after a new-session send changes draftKey',
    );
    assert.match(
      draftHook,
      /function clearDraft\(key: string \| undefined\) \{\s*rememberComposerDraft\(draftStoreRef\.current, key, ''\);/,
      'clearDraft must remove the stored draft under the submitted key',
    );
  });

  it('drops late send cleanup and draft reset after the Composer unmounts', async () => {
    const source = await readFile(join(process.cwd(), '../../packages/ui/src/composer.tsx'), 'utf8');
    const composerBlock = source.match(/export const Composer = forwardRef[\s\S]*$/)?.[0] ?? '';
    const sendCurrent = source.match(/async function sendCurrent\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(composerBlock, /const composerMountedRef = useMountedRef\(\)/);
    assert.match(
      composerBlock,
      /useEffect\(\(\) => \{\s*return \(\) => \{\s*sendPendingRef\.current = false;\s*importActionOwnerRef\.current\?\.reset\(\);\s*\};\s*\}, \[\]\)/,
      'Composer must release send/import pending owners when it unmounts or StrictMode replays cleanup',
    );
    assert.match(
      sendCurrent,
      /sendPendingRef\.current = false;[\s\S]*if \(composerMountedRef\.current\) setSendPending\(false\);[\s\S]*if \(!composerMountedRef\.current\) return;[\s\S]*if \(sent === false\) return;/,
      'late send completion after unmount must not clear UI state, mutate draft history, or reset the old form',
    );
  });

  it('keeps streaming stop single-flight across the button and Esc key', async () => {
    const source = await readFile(join(process.cwd(), '../../packages/ui/src/composer.tsx'), 'utf8');
    const keydown = source.match(/function onTextareaKeyDown\(event: KeyboardEvent<HTMLTextAreaElement>\) \{[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(source, /stopPending\?: boolean;/, 'Composer must accept app-shell stop pending state');
    assert.match(source, /onStop\(\): void \| Promise<void>;/, 'Composer onStop may be Promise-returning');
    assert.match(
      keydown,
      /if \(event\.key === 'Escape' && props\.streaming\) \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?if \(props\.stopPending\) return;[\s\S]*?props\.onStop\(\);/,
      'Esc must not re-send stop while a stop request is already pending',
    );
    // #1565 PR 3: Astryx Button spells the disabled prop `isDisabled`.
    assert.match(source, /isDisabled=\{props\.stopPending\}/);
    assert.match(source, /if \(props\.stopPending\) return;[\s\S]*void props\.onStop\(\);/);
    assert.match(source, /aria-busy=\{props\.stopPending \? 'true' : undefined\}/);
    assert.match(source, /data-pending=\{props\.stopPending \? 'true' : undefined\}/);
    assert.match(source, /\{props\.stopPending \? copy\.stopping : copy\.stopLabel\}/);
  });
});
