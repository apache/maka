import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// Exercise the player's actual storage imports without a DOM or a built
// WebAssembly runtime: strings stand in for the pointers passed by Rust.
const source = readFileSync(new URL('../../crates/nsh-platform-web/web/nsh.js', import.meta.url), 'utf8');
const imports = source.slice(source.indexOf('    const imports = {'), source.indexOf('    const response ='));
// The module's own functions the imports name, as the module declares them.
const helper = (name: string) => {
  const start = source.indexOf(`\nfunction ${name}(`);
  return source.slice(start, source.indexOf('\n}\n', start) + 3);
};
const helpers = ['localOffset', 'timeZoneName'].map(helper).join('');
const makeImports = new Function('localStorage', `${helpers}${imports} return imports.nsh;`);

test('storage round-trips arbitrary string keys and clears only its namespace', () => {
  const kept = new Map<string, string>([['other', 'kept'], ['nsh:/other/:draft', 'kept']]);
  const localStorage = {
    get length() { return kept.size; },
    key: (index: number) => [...kept.keys()][index] ?? null,
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => { kept.set(key, value); },
    removeItem: (key: string) => { kept.delete(key); },
  };
  const player = { str: (text: string) => text, storage: (f: () => unknown) => f() };
  const storage = makeImports.call(player, localStorage);
  const prefix = 'nsh:/app/:';
  const entries = new Map(['__proto__', 'constructor', 'toString', '', '键😀'].map((key) => [key, `value:${key}`]));
  for (const [key, value] of entries) storage.storage_set(prefix, 0, key, 0, value, 0);
  const loaded = JSON.parse(storage.storage_load(prefix, 0));
  expect(Object.keys(loaded).sort()).toEqual([...entries.keys()].sort());
  for (const [key, value] of entries) expect(loaded[key]).toBe(value);
  storage.storage_remove(prefix, 0, '__proto__', 0);
  expect(Object.hasOwn(JSON.parse(storage.storage_load(prefix, 0)), '__proto__')).toBe(false);
  storage.storage_clear(prefix, 0);
  expect(JSON.parse(storage.storage_load(prefix, 0))).toEqual({});
  expect([...kept]).toEqual([['other', 'kept'], ['nsh:/other/:draft', 'kept']]);
});
