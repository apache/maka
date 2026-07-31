import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';

const REPO_ROOT = join(process.cwd(), '..', '..');
const TOAST_SOURCE = join(REPO_ROOT, 'packages/ui/src/toast.tsx');

describe('toast.confirm keyboard safety contract', () => {
  it('queues overlapping confirm requests instead of overwriting the active dialog', async () => {
    const src = await readFile(TOAST_SOURCE, 'utf8');

    assert.match(src, /const activeConfirmRef = useRef<PendingConfirm \| null>\(null\)/);
    assert.match(src, /const confirmQueueRef = useRef<PendingConfirm\[\]>\(\[\]\)/);
    assert.match(
      src,
      /if \(activeConfirmRef\.current\) \{\s*confirmQueueRef\.current\.push\(request\);\s*return;\s*\}/,
      'a second confirm request must be queued while a dialog is active',
    );
    assert.doesNotMatch(
      src,
      /setConfirmState\(\{\s*\.\.\.input,\s*resolve\s*\}\)/,
      'a second confirm request must not overwrite and strand the active Promise',
    );
  });

  it('settles one confirm at a time and advances the queued dialog', async () => {
    const src = await readFile(TOAST_SOURCE, 'utf8');

    assert.match(src, /const current = activeConfirmRef\.current;/);
    assert.match(src, /if \(!current\) return;/);
    assert.match(src, /activeConfirmRef\.current = null;\s*current\.resolve\(result\);/);
    assert.match(src, /const next = confirmQueueRef\.current\.shift\(\) \?\? null;/);
    assert.match(src, /activeConfirmRef\.current = next;\s*setConfirmState\(next\);/);
  });

  it('cancels active and queued confirm requests when the provider unmounts', async () => {
    const src = await readFile(TOAST_SOURCE, 'utf8');

    assert.match(src, /activeConfirmRef\.current\?\.resolve\(false\);/);
    assert.match(src, /for \(const pending of confirmQueueRef\.current\) \{\s*pending\.resolve\(false\);\s*\}/);
    assert.match(src, /confirmQueueRef\.current = \[\];/);
  });

  it('does not globally map Enter to destructive confirmation', async () => {
    const src = await readFile(TOAST_SOURCE, 'utf8');
    const confirmBlock = src.match(/function ConfirmDialog[\s\S]*?\n\}/)?.[0] ?? '';

    assert.match(confirmBlock, /<AstryxAlertDialog/, 'confirm must delegate accessible alertdialog semantics to Astryx');
    assert.doesNotMatch(
      confirmBlock,
      /addEventListener\('keydown'[\s\S]*event\.key === 'Enter'[\s\S]*onResolve\(true\)/,
      'Enter must not be captured globally because Enter on the focused cancel button would confirm',
    );
    assert.doesNotMatch(
      confirmBlock,
      /event\.key === 'Enter'[\s\S]*preventDefault\(\)[\s\S]*onResolve\(true\)/,
      'ConfirmDialog must let focused buttons handle Enter/Space natively',
    );
  });

  it('delegates least-destructive initial focus to Astryx AlertDialog', async () => {
    const src = await readFile(TOAST_SOURCE, 'utf8');
    const confirmBlock = src.match(/function ConfirmDialog[\s\S]*?\n\}/)?.[0] ?? '';

    assert.match(confirmBlock, /<AstryxAlertDialog/);
    assert.match(confirmBlock, /cancelLabel=\{cancelLabel\}/);
    assert.doesNotMatch(confirmBlock, /initialFocus|cancelRef|<button\b|<Button\b/, 'Maka must not create a second focus policy or button tree');
  });

  it('remounts ConfirmDialog on queue advance so initialFocus re-targets the cancel button', async () => {
    const src = await readFile(TOAST_SOURCE, 'utf8');
    assert.match(src, /const request: PendingConfirm = \{ id: `c\$\{\+\+idSeed\.current\}`, \.\.\.input, resolve \}/);
    assert.match(
      src,
      /<ConfirmDialog key=\{confirmState\.id\} request=\{confirmState\}/,
      'ConfirmDialog must remount on queue advance so native dialog opening semantics focus the next cancel action',
    );
  });
});
