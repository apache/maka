/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// What the user gives each quick tool entry: a global shortcut that runs it from anywhere, and
// an alias typed in place of its keyword.

/** A user's choices for one entry; an entry without any has no record. */
export type CommandChoice = { readonly shortcut?: string; readonly alias?: string };
/** By entry key: the tool's plugin path and contribution, then the entry's first keyword. */
export type CommandChoices = Readonly<Record<string, CommandChoice>>;

export const MAX_ALIAS_LENGTH = 32;

const isChoice = (value: unknown): value is CommandChoice => {
  const choice = value as Record<string, unknown> | null;
  return (
    typeof choice === 'object' &&
    choice !== null &&
    (choice.shortcut === undefined || typeof choice.shortcut === 'string') &&
    (choice.alias === undefined || typeof choice.alias === 'string')
  );
};

/** Stored choices; damaged data is an error, not an empty set that would drop them on save. */
export function parseChoices(stored: string | null): CommandChoices {
  if (stored === null) return {};
  const value: unknown = JSON.parse(stored);
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('The quick tool shortcuts are damaged.');
  for (const choice of Object.values(value))
    if (!isChoice(choice)) throw new Error('The quick tool shortcuts are damaged.');
  return value as CommandChoices;
}

/** `choices` with `key`'s choice changed; an emptied choice is dropped. */
export function choose(
  choices: CommandChoices,
  key: string,
  patch: Partial<Record<keyof CommandChoice, string | null>>,
): CommandChoices {
  const merged = { ...choices[key], ...patch };
  const next: { shortcut?: string; alias?: string } = {};
  if (merged.shortcut) next.shortcut = merged.shortcut;
  if (merged.alias) next.alias = merged.alias;
  const { [key]: _, ...rest } = choices;
  return next.shortcut || next.alias ? { ...rest, [key]: next } : rest;
}

/** An alias as typed: one lowercase word, since a space ends it in the query. */
export const normalAlias = (text: string) =>
  text.trim().toLowerCase().replace(/\s+/g, '').slice(0, MAX_ALIAS_LENGTH);

/** Exact aliases and keywords rank ahead of search results. */
export function entryMatch(
  text: string,
  alias: string | undefined,
  keywords: readonly string[],
): number | null {
  const word = text.trim().toLowerCase();
  if (!word) return null;
  if (word === alias) return -2;
  return keywords.some((keyword) => keyword.toLowerCase() === word) ? -1 : null;
}

const KEYS = [
  ...'abcdefghijklmnopqrstuvwxyz0123456789',
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
  'space',
  'enter',
  'up',
  'down',
  'left',
  'right',
  ',',
  '.',
  '/',
  ';',
  "'",
  '[',
  ']',
  '\\',
  '-',
  'plus',
  '`',
];

/** What the platform keeps for quitting, hiding, minimizing and full screen; never bindable. */
const RESERVED = {
  apple: ['cmd+q', 'cmd+h', 'cmd+alt+h', 'cmd+m', 'cmd+ctrl+f'],
  other: ['ctrl+q', 'alt+f4', 'f11'],
};

/**
 * Every shortcut a recorder can take: a key with Command, Control or Option (and maybe Shift),
 * or a function key alone. Bare keys and Shift alone type text, so they are left out, and so
 * are the keys the platform keeps.
 */
export function recordable(apple: boolean): string[] {
  const reserved = new Set(apple ? RESERVED.apple : RESERVED.other);
  const held = ['cmd', 'ctrl', 'alt'];
  const sets: string[][] = [];
  for (let mask = 1; mask < 1 << held.length; mask += 1) {
    const set = held.filter((_, index) => mask & (1 << index));
    sets.push(set, [...set, 'shift']);
  }
  const functionKeys = KEYS.filter((key) => /^f\d+$/.test(key));
  return [
    ...functionKeys,
    ...sets.flatMap((set) => KEYS.map((key) => [...set, key].join('+'))),
  ].filter((keystroke) => !reserved.has(keystroke));
}
