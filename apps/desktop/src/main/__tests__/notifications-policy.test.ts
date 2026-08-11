import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveNotificationContent,
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

it('sanitizes renderer content, caps it, and falls back per field', () => {
  const clean = resolveNotificationContent({
    kind: 'completed',
    title: '  会话  A  ',
    body: 'line one\n\nline two\tindented',
  });
  assert.deepEqual(clean, { title: '会话 A', body: 'line one line two indented' });

  const completedFallback = resolveNotificationContent({ kind: 'completed' });
  for (const value of ['   ', undefined]) {
    assert.deepEqual(
      resolveNotificationContent({ kind: 'completed', title: value, body: value }),
      completedFallback,
    );
  }

  const capped = resolveNotificationContent({ kind: 'completed', title: 'S', body: 'x'.repeat(500) });
  assert.equal(capped.body.length, 160);
  assert.ok(capped.body.endsWith('…'));

  const erroredFallback = resolveNotificationContent({ kind: 'errored' });
  assert.deepEqual(resolveNotificationContent({ kind: 'errored', title: '出错的会话', body: '' }), {
    title: '出错的会话',
    body: erroredFallback.body,
  });
});
