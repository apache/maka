import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveScrollMotionBehavior } from '../../renderer/scroll-motion-policy.js';

const base = {
  reducedMotionAttr: false,
  e2eFixtureAttr: false,
  prefersReducedMotion: false,
};

test('captures collapse scroll motion, and a fixture can ask for it back', () => {
  assert.equal(resolveScrollMotionBehavior(base), 'smooth');
  assert.equal(
    resolveScrollMotionBehavior({ ...base, e2eFixtureAttr: true }),
    'auto',
    'a capture is deterministic by default',
  );
  assert.equal(
    resolveScrollMotionBehavior({ ...base, e2eFixtureAttr: true, scrollMotionAttr: 'smooth' }),
    'smooth',
    'a fixture whose subject is scrolling opts back in',
  );
});

test('no fixture request outranks a preference for less motion', () => {
  for (const reduced of [
    { reducedMotionAttr: true },
    { prefersReducedMotion: true },
  ] as const) {
    assert.equal(
      resolveScrollMotionBehavior({
        ...base,
        ...reduced,
        e2eFixtureAttr: true,
        scrollMotionAttr: 'smooth',
      }),
      'auto',
    );
  }
});

test('a fixture can also ask for no motion outside a capture', () => {
  assert.equal(resolveScrollMotionBehavior({ ...base, scrollMotionAttr: 'auto' }), 'auto');
});
