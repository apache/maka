import { describe, expect, test } from 'bun:test';
import en from '../src/home/en.json';
import zh from '../src/home/zh-CN.json';

// The home page's words: Chinese is written beside the English, and the
// machine translations (longbridge/nsh-website-translates) take `en.json`'s
// shape, so both hold the same keys and lists of the same length.
const shape = (value: unknown): unknown =>
  typeof value === 'string'
    ? 'string'
    : Array.isArray(value)
      ? value.map(shape)
      : Object.fromEntries(Object.entries(value as object).map(([key, item]) => [key, shape(item)]));

const strings = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : Object.values(value as object).flatMap(strings);

describe('home copy', () => {
  test('Chinese has the shape of the English', () => {
    expect(shape(zh)).toEqual(shape(en));
  });
  test('every string is filled in, except the tables\' corner cells', () => {
    for (const copy of [en, zh]) {
      const empty = strings(copy).filter((s) => !s.trim()).length;
      expect(empty).toBe(2); // compareCols[0], sizeCols[0]
    }
  });
});
