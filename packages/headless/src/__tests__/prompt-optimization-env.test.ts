import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  envFinitePositiveNumber,
  envNonNegativeInt,
  envPositiveInt,
  envRatio,
  resolveMinStable,
  smokeExitCode,
} from '../prompt-optimization-env.js';

describe('prompt optimization environment parsing', () => {
  test('parses supported values and applies optional fallbacks', () => {
    assert.equal(envNonNegativeInt('N', undefined, 7), 7);
    assert.equal(envNonNegativeInt('N', '', 7), 7);
    assert.equal(envNonNegativeInt('N', '0', 7), 0);
    assert.equal(envNonNegativeInt('N', '42', 7), 42);

    assert.equal(envPositiveInt('N', undefined, 10), 10);
    assert.equal(envPositiveInt('N', '', 10), 10);
    assert.equal(envPositiveInt('N', undefined, undefined), undefined);
    assert.equal(envPositiveInt('N', '1', 10), 1);

    assert.equal(envFinitePositiveNumber('N', undefined, 30), 30);
    assert.equal(envFinitePositiveNumber('N', '', 30), 30);
    assert.equal(envFinitePositiveNumber('N', undefined, undefined), undefined);
    assert.equal(envFinitePositiveNumber('N', '0.5', undefined), 0.5);

    assert.equal(envRatio('R', undefined, 0.5), 0.5);
    assert.equal(envRatio('R', '', 0.5), 0.5);
    assert.equal(envRatio('R', undefined, undefined), undefined);
    assert.equal(envRatio('R', '1', 0.5), 1);
    assert.equal(envRatio('R', '0.25', 0.5), 0.25);
  });

  test('rejects a negative, fractional, or non-numeric non-negative integer', () => {
    for (const value of ['abc', '1.5', '-1']) {
      assert.throws(() => envNonNegativeInt('N', value, 7), /N must be a non-negative integer/);
    }
  });

  test('rejects non-positive and non-integer positive integers', () => {
    assert.throws(() => envPositiveInt('N', '0', 10), /N must be a positive integer/);
    for (const value of ['-1', '2.5']) {
      assert.throws(() => envPositiveInt('N', value, 10), /N must be a non-negative integer/);
    }
  });

  test('rejects non-finite or non-positive finite numbers', () => {
    for (const value of ['abc', '0', '-5', 'Infinity']) {
      assert.throws(
        () => envFinitePositiveNumber('N', value, undefined),
        /N must be a finite positive number/,
      );
    }
  });

  test('rejects ratios outside (0, 1] and non-numeric ratios', () => {
    for (const value of ['0', '1.5', 'abc']) {
      assert.throws(() => envRatio('R', value, 0.5), /R must be a number in \(0, 1\]/);
    }
  });
});

describe('resolveMinStable', () => {
  test('uses a valid explicit count and rejects invalid or disabled guards', () => {
    assert.equal(resolveMinStable('M', 50, '1', 0.5), 1);
    assert.equal(resolveMinStable('M', 50, '3', 0.5), 3);
    assert.throws(() => resolveMinStable('M', 50, 'abc', 0.5), /M must be a non-negative integer/);
    assert.throws(() => resolveMinStable('M', 50, '0', 0.5), /M must be a positive integer/);
  });

  test('otherwise scales with the requested size, rounded up and bounded at one', () => {
    assert.equal(resolveMinStable('M', 50, undefined, 0.5), 25);
    assert.equal(resolveMinStable('M', 27, undefined, 0.5), 14);
    assert.equal(resolveMinStable('M', 1, undefined, 0.5), 1);
    assert.equal(resolveMinStable('M', 0, undefined, 0.5), 1);
  });
});

test('smokeExitCode succeeds only for a passing smoke', () => {
  assert.equal(smokeExitCode('pass'), 0);
  assert.equal(smokeExitCode('fail'), 1);
  assert.equal(smokeExitCode('error'), 1);
  assert.equal(smokeExitCode(''), 1);
});
