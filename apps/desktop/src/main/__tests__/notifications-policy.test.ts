import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRunNotificationKind,
  resolveNotificationContent,
  runNotificationCopy,
  shouldRaiseRunNotification,
} from '../notifications-policy.js';

it('gates native notifications through every required condition', () => {
  const base = { enabled: true, supported: true, windowFocused: false, incognito: false, e2e: false };
  const cases = [
    [base, true],
    [{ ...base, enabled: false }, false],
    [{ ...base, supported: false }, false],
    [{ ...base, windowFocused: true }, false],
    [{ ...base, incognito: true }, false],
    [{ ...base, e2e: true }, false],
  ] as const;

  for (const [input, expected] of cases) {
    assert.equal(shouldRaiseRunNotification(input), expected);
  }
});

it('recognizes terminal kinds and keeps distinct fallback copy', () => {
  for (const value of ['completed', 'errored']) assert.equal(isRunNotificationKind(value), true);
  for (const value of ['complete', 'error', 'aborted', '', undefined, null, 1, {}]) {
    assert.equal(isRunNotificationKind(value), false);
  }

  const completed = runNotificationCopy('completed');
  const errored = runNotificationCopy('errored');
  assert.ok(completed.title && completed.body);
  assert.ok(errored.title && errored.body);
  assert.notEqual(completed.title, errored.title);
});

it('sanitizes renderer content, caps it, and falls back per field', () => {
  const clean = resolveNotificationContent({
    kind: 'completed',
    title: '  会话  A  ',
    body: 'line one\n\nline two\tindented',
  });
  assert.deepEqual(clean, { title: '会话 A', body: 'line one line two indented' });

  const completedFallback = runNotificationCopy('completed');
  for (const value of ['', '   ', undefined, null, 42, {}]) {
    assert.deepEqual(
      resolveNotificationContent({ kind: 'completed', title: value, body: value }),
      completedFallback,
    );
  }

  const capped = resolveNotificationContent({ kind: 'completed', title: 'S', body: 'x'.repeat(500) });
  assert.equal(capped.body.length, 160);
  assert.ok(capped.body.endsWith('…'));

  const erroredFallback = runNotificationCopy('errored');
  assert.deepEqual(resolveNotificationContent({ kind: 'errored', title: '出错的会话', body: '' }), {
    title: '出错的会话',
    body: erroredFallback.body,
  });
});
