import { describe, test } from 'node:test';
import { expect } from '../../__tests__/test-helpers.js';
import { applySensitivePatch, maskSensitive } from '../network-settings.js';

describe('applySensitivePatch', () => {
  test('handles plaintext, placeholder, empty string, and undefined', () => {
    expect(applySensitivePatch('old', 'new')).toBe('new');
    expect(applySensitivePatch('old', '••••••••')).toBe('old');
    expect(applySensitivePatch('old', '')).toBeUndefined();
    expect(applySensitivePatch('old', undefined)).toBe('old');
  });
});

describe('maskSensitive', () => {
  test('masks only non-empty values', () => {
    expect(maskSensitive('secret')).toBe('••••••••');
    expect(maskSensitive('')).toBeUndefined();
    expect(maskSensitive(undefined)).toBeUndefined();
  });
});
