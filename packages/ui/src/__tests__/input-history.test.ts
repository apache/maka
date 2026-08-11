import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  readGlobalInputHistory,
  saveGlobalInputHistoryEntry,
  clearGlobalInputHistory,
} from '../input-history.js';

/**
 * Minimal in-memory localStorage stand-in for Node test runs (no DOM).
 * The module under test reads/writes `globalThis.localStorage`.
 */
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

const STORAGE_KEY = 'maka-input-history';

let savedLocalStorage: typeof globalThis.localStorage | undefined;

beforeEach(() => {
  savedLocalStorage = globalThis.localStorage;
  globalThis.localStorage = new MemoryStorage() as Storage;
});

afterEach(() => {
  if (savedLocalStorage === undefined) {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  } else {
    globalThis.localStorage = savedLocalStorage;
  }
});





test('saveGlobalInputHistoryEntry dedups and moves the match to newest', () => {
  saveGlobalInputHistoryEntry('重复的问题');
  saveGlobalInputHistoryEntry('第二条');
  saveGlobalInputHistoryEntry('重复的问题');
  // The re-sent entry should move to the end (newest), not duplicate.
  assert.deepEqual(readGlobalInputHistory(), ['第二条', '重复的问题']);
});

test('saveGlobalInputHistoryEntry caps at 50 entries, dropping oldest', () => {
  for (let i = 1; i <= 55; i++) {
    saveGlobalInputHistoryEntry(`prompt-${i}`);
  }
  const entries = readGlobalInputHistory() ?? [];
  assert.equal(entries.length, 50, 'history must be capped at 50 entries');
  // Oldest five (prompt-1..prompt-5) dropped; newest 50 kept in order.
  assert.equal(entries[0], 'prompt-6');
  assert.equal(entries[49], 'prompt-55');
});

test('readGlobalInputHistory returns null on corrupt JSON (do not clobber in-memory history)', () => {
  globalThis.localStorage!.setItem(STORAGE_KEY, 'not-valid-json{');
  assert.equal(readGlobalInputHistory(), null);
});

test('readGlobalInputHistory returns null on a non-array JSON value', () => {
  globalThis.localStorage!.setItem(STORAGE_KEY, JSON.stringify({ not: 'an array' }));
  assert.equal(readGlobalInputHistory(), null);
});

test('readGlobalInputHistory filters non-string elements from the array', () => {
  globalThis.localStorage!.setItem(
    STORAGE_KEY,
    JSON.stringify(['keep', 42, null, { bad: true }, 'also-keep']),
  );
  assert.deepEqual(readGlobalInputHistory(), ['keep', 'also-keep']);
});

test('clearGlobalInputHistory removes the stored key', () => {
  saveGlobalInputHistoryEntry('要被清掉的');
  assert.notEqual(globalThis.localStorage!.getItem(STORAGE_KEY), null);
  clearGlobalInputHistory();
  assert.equal(globalThis.localStorage!.getItem(STORAGE_KEY), null);
  assert.deepEqual(readGlobalInputHistory(), []);
});


test('readGlobalInputHistory returns null when localStorage.getItem throws (storage unavailable)', () => {
  const original = globalThis.localStorage!.getItem;
  globalThis.localStorage!.getItem = () => {
    throw new Error('unavailable');
  };
  try {
    assert.equal(readGlobalInputHistory(), null);
  } finally {
    globalThis.localStorage!.getItem = original;
  }
});
