import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { TurnView } from '../chat-turn.js';
import { LocaleProvider } from '../locale-context.js';
import type { TurnViewModel } from '../materialize.js';

function statusHasSpinner(toolStatuses: readonly ('running' | 'completed')[]): boolean {
  const tools = toolStatuses.map((status, index) => ({
    toolUseId: `tool-${index + 1}`,
    toolName: 'Bash',
    status,
    args: {},
  } as const));
  const turn: TurnViewModel = {
    turnId: 'turn-1',
    status: 'running',
    partialOutputRetained: false,
    tools,
    notes: [],
    startedAt: 1,
    timeline: [{ kind: 'tools', items: tools }],
  };
  const markup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <TurnView turn={turn} liveStreaming={{ runningStatus: true }} />
    </LocaleProvider>,
  );
  const { document } = parseHTML(markup);
  return document.querySelector('.maka-turn-processing .astryx-spinner') !== null;
}

test('hands the spinner to the turn status after the tool settles', () => {
  assert.equal(statusHasSpinner(['running']), false);
  assert.equal(statusHasSpinner(['completed']), true);
});

test('keeps the turn spinner when a collapsed group hides the running tool', () => {
  assert.equal(statusHasSpinner(['running', 'completed']), true);
});
