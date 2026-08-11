import { test } from 'node:test';
import { expect } from '../test-helpers.js';
import { aggregateMessageContents } from '../events.js';

test('aggregates inline references against the combined display text', () => {
  expect(
    aggregateMessageContents([
      {
        text: '<skill>Alpha</skill>\n\nFirst',
        displayText: '/skill:alpha First',
        inlineReferences: [{ kind: 'skill', value: '/skill:alpha', label: 'Alpha', start: 0 }],
      },
      {
        text: '<skill>Beta</skill>\n\nSecond',
        displayText: '/skill:beta Second',
        inlineReferences: [{ kind: 'skill', value: '/skill:beta', label: 'Beta', start: 0 }],
      },
    ]),
  ).toEqual({
    text: '<skill>Alpha</skill>\n\nFirst\n\n<skill>Beta</skill>\n\nSecond',
    displayText: '/skill:alpha First\n\n/skill:beta Second',
    inlineReferences: [
      { kind: 'skill', value: '/skill:alpha', label: 'Alpha', start: 0 },
      { kind: 'skill', value: '/skill:beta', label: 'Beta', start: 20 },
    ],
  });
});

test('preserves an explicit empty inline-reference marker while aggregating', () => {
  expect(aggregateMessageContents([{ text: 'plain', inlineReferences: [] }])).toEqual({
    text: 'plain',
    inlineReferences: [],
  });
});
